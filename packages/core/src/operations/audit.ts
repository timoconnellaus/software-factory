// audit.verify (ADR 0591): re-hashes the audit archive's chain for a range of days and checks it
// against what D1 recorded, so an org admin can prove the archived journal is whole.
import { sql } from "kysely";
import { z } from "zod";
import { checkChunk, GENESIS, nextDay, prevDay } from "../audit-chain.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation } from "../operation.ts";

/** Days one call verifies at most. */
export const VERIFY_MAX_DAYS = 31;
/** Archived objects one call reads at most (each up to 1 MB). */
export const VERIFY_MAX_CHUNKS = 100;

/**
 * One day's verdict. No row or object counts: the archive holds every org's machine rows, so an
 * org admin learns whether the chain is whole, not how busy other orgs were.
 */
const dayVerdict = z.object({
  day: z.string(),
  ok: z.boolean(),
  /**
   * `archived`; `before the archive` (earlier than its first day: nothing to archive); `not yet`
   * (after its last day: not due or not reached yet); `missing` (between archived days: a gap);
   * `partial`, verified so far and the call stopped at its object cap: call again with `next`.
   */
  status: z.enum(["archived", "partial", "before the archive", "not yet", "missing"]),
  why: z.string().nullable(),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a UTC day, YYYY-MM-DD");

export const auditVerify = defineOperation({
  name: "audit.verify",
  description:
    "Verify the audit archive's hash chain for a range of UTC days (at most 31): every archived object is read fresh from R2 and re-hashed from the previous day's root, and each day's root and link are checked against D1's records. A missing, altered, added or reordered row, a missing object or a missing day is reported with the day and why. Reports a verdict per day only, never rows or counts: the archive holds every org's machine rows, so any org admin may verify that it is whole, without learning how busy other orgs were.",
  risk: "read",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    orgId: z.string().min(1),
    from: day,
    to: day,
    /** Carry on after this object (the `next` an earlier call answered), within or after its day. */
    after: z.object({ day, seq: z.number().int().min(1) }).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    days: z.array(dayVerdict),
    /** The call stopped at its object cap: call again with `after: next` (the same range). */
    next: z.object({ day: z.string(), seq: z.number() }).nullable(),
  }),
  async handler(input, ctx) {
    if (input.to < input.from) throw new OperationError("invalid_input", "`to` is before `from`");
    const span = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000 + 1;
    if (span > VERIFY_MAX_DAYS) {
      throw new OperationError("invalid_input", `at most ${VERIFY_MAX_DAYS} days in one call`);
    }
    const store = ctx.services.runArchive;
    if (!store) throw new OperationError("unavailable", "the archive isn't bound here");
    const after = input.after ?? null;
    if (after && (after.day < input.from || after.day > input.to)) {
      throw new OperationError("invalid_input", "`after` is outside the range");
    }
    const start = after?.day ?? input.from;
    // The days (and the one before, for its root), the objects from where this call starts, and
    // the object it carries on from, by primary key ranges.
    const [days, chunks, bounds, resumed] = await Promise.all([
      ctx.db
        .selectFrom("core_audit_archives")
        .selectAll()
        .where("day", ">=", prevDay(start))
        .where("day", "<=", input.to)
        .orderBy("day")
        .execute(),
      ctx.db
        .selectFrom("core_audit_archive_chunks")
        .selectAll()
        .where("day", ">=", start)
        .where("day", "<=", input.to)
        .$if(after !== null, (q) =>
          q.where((eb) =>
            eb.or([
              eb("day", ">", start),
              eb.and([eb("day", "=", start), eb("seq", ">", (after as { seq: number }).seq)]),
            ]),
          ),
        )
        .orderBy("day")
        .orderBy("seq")
        .limit(VERIFY_MAX_CHUNKS + 1)
        .execute(),
      // Each on its own (SQLite reads one end of the primary key for a lone min or max).
      ctx.db
        .selectNoFrom([
          sql<string | null>`(SELECT min(day) FROM core_audit_archives)`.as("first"),
          sql<string | null>`(SELECT max(day) FROM core_audit_archives)`.as("last"),
        ])
        .executeTakeFirst(),
      after
        ? ctx.db
            .selectFrom("core_audit_archive_chunks")
            .select("last_hash")
            .where("day", "=", after.day)
            .where("seq", "=", after.seq)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);
    if (after && !resumed) throw new OperationError("not_found", "no such archived object");
    const byDay = new Map(days.map((d) => [d.day, d]));
    const first = bounds?.first ?? null;
    const last = bounds?.last ?? null;
    const capped = chunks.length > VERIFY_MAX_CHUNKS;
    const listed = chunks.slice(0, VERIFY_MAX_CHUNKS);
    const out: z.infer<typeof dayVerdict>[] = [];
    let next: { day: string; seq: number } | null = null;
    for (let d = start; d <= input.to; d = nextDay(d)) {
      const rec = byDay.get(d);
      if (!rec) {
        if (first === null || d > (last as string)) {
          out.push({ day: d, ok: true, status: "not yet", why: null });
        } else if (d < first) {
          out.push({ day: d, ok: true, status: "before the archive", why: null });
        } else {
          out.push({
            day: d,
            ok: false,
            status: "missing",
            why: "between archived days, but not recorded: a gap in the chain",
          });
        }
        continue;
      }
      const theirs = listed.filter((c) => c.day === d);
      const resume = after !== null && d === after.day;
      // The cap cut into this day: verify what was read, then stop here with a cursor.
      const cut = capped && (listed.at(-1)?.day ?? "") === d;
      const result = await verifyDay(
        rec,
        byDay.get(prevDay(d)) ?? null,
        first === d,
        theirs,
        resume ? { seq: (after as { seq: number }).seq, hash: resumed?.last_hash ?? "" } : null,
        !cut,
      );
      if (cut && result.ok) {
        const end = theirs.at(-1);
        out.push({ day: d, ok: true, status: "partial", why: null });
        if (end) next = { day: d, seq: end.seq };
        break;
      }
      out.push({ day: d, status: "archived", ...result });
      if (cut) break;
    }
    return { ok: out.every((x) => x.ok), days: out, next };

    async function verifyDay(
      rec: (typeof days)[number],
      before: (typeof days)[number] | null,
      first: boolean,
      theirs: typeof chunks,
      from: { seq: number; hash: string } | null,
      whole: boolean,
    ): Promise<{ ok: boolean; why: string | null }> {
      const fail = (why: string) => ({ ok: false, why });
      if (!from) {
        if (first ? rec.prev_root !== GENESIS : before === null) {
          return fail(
            first ? "the first day doesn't chain from genesis" : "the day before isn't archived",
          );
        }
        if (before && rec.prev_root !== before.root) {
          return fail("doesn't chain from the day before's root");
        }
      }
      let prev = from ? from.hash : rec.prev_root;
      let seq = from ? from.seq : 0;
      for (const c of theirs) {
        seq += 1;
        if (c.seq !== seq) return fail(`object ${seq} is missing from the records`);
        let body: string | null;
        try {
          body = (await store?.get(c.r2_key, { fresh: true })) ?? null;
        } catch {
          return fail(`couldn't read object ${c.seq} from the archive; try again`);
        }
        if (body === null) return fail(`object ${c.seq} is missing from the archive`);
        const check = await checkChunk(c, prev, body);
        if (!check.ok) return fail(`object ${c.seq}: ${check.why}`);
        prev = check.last;
      }
      if (!whole) return { ok: true, why: null };
      // The day is done: its records add up to what the day says (one read of its chunk records).
      const totals = await ctx.db
        .selectFrom("core_audit_archive_chunks")
        .select([
          sql<number>`count(*)`.as("n"),
          sql<number>`coalesce(sum(rows), 0)`.as("rows"),
          sql<number>`coalesce(max(seq), 0)`.as("top"),
        ])
        .where("day", "=", rec.day)
        .executeTakeFirst();
      if (seq !== rec.chunks || totals?.n !== rec.chunks || totals?.top !== rec.chunks) {
        return fail("the day's objects don't match what the day records");
      }
      if (totals?.rows !== rec.rows) return fail("the objects don't hold the rows the day records");
      if (prev !== rec.root) return fail("the root doesn't match the last row's hash");
      return { ok: true, why: null };
    }
  },
});

/** Stopped archiver ticks in a row that open its incident (sf-engine counts them). */
export const AUDIT_ARCHIVE_STOPS_FOR_INCIDENT = 3;

export const auditArchiveHealth = defineOperation({
  name: "audit.archiveHealth",
  description:
    "The audit archiver reports that it has stopped (three ticks in a row) or archives again (ADR 0591). Stopped: records one incident for a person, the factory's own (no org, project or work item), shown on the desktop's Checks and incidents page, unless one is open. Archiving again: resolves it. Run only by the scheduler, from sf-engine's cron.",
  risk: "write",
  actors: ["scheduler"],
  permission: "signed-in",
  audit: { changesOnly: true },
  input: z.object({
    stopped: z.boolean(),
    reason: z.string().max(2_000).default(""),
  }),
  output: z.object({ incidentId: z.string().nullable(), resolved: z.boolean() }),
  async handler(input, ctx) {
    // core_incidents_audit_archive_idx: the one open archiver incident, if any.
    const open = await ctx.db
      .selectFrom("core_incidents")
      .select("id")
      .where("kind", "=", "audit_archive_stopped")
      .where("resolved_at", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (input.stopped) {
      if (open) return { incidentId: open.id, resolved: false };
      const id = newId("incident");
      ctx.write(
        ctx.db.insertInto("core_incidents").values({
          id,
          // The factory's own incident: no org, project or work item (migration 0366's CHECK
          // allows that for this kind only; the row type names the columns every other kind has).
          org_id: null as unknown as string,
          project_id: null as unknown as string,
          source_work_item_id: null as unknown as string,
          run_id: null,
          kind: "audit_archive_stopped",
          reason: input.reason || "The audit archive has stopped.",
          fix_work_item_id: null,
          created_by: ctx.actor.id,
          created_at: ctx.now,
          root_cause: null,
          proposed_fix: null,
        }),
      );
      ctx.change({ entity: "incident", id, after: { kind: "audit_archive_stopped" } });
      return { incidentId: id, resolved: false };
    }
    if (!open) return { incidentId: null, resolved: false };
    ctx.write(
      ctx.db
        .updateTable("core_incidents")
        .set({
          resolved_at: ctx.now,
          resolved_by: ctx.actor.id,
          resolution: "The audit archive archived again.",
        })
        .where("id", "=", open.id)
        .where("resolved_at", "is", null),
    );
    ctx.change({ entity: "incident", id: open.id, after: { resolved: true } });
    return { incidentId: open.id, resolved: true };
  },
});
