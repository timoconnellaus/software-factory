// audit.verify (ADR 0591): re-hashes the audit archive's chain for a range of days and checks it
// against what D1 recorded, so an org admin can prove the archived journal is whole.
import { sql } from "kysely";
import { z } from "zod";
import { checkChunk, GENESIS, nextDay, prevDay } from "../audit-chain.ts";
import { OperationError } from "../errors.ts";
import { defineOperation } from "../operation.ts";

/** Days one call verifies at most. */
export const VERIFY_MAX_DAYS = 31;
/** Archived objects one call reads at most (each up to 1 MB). */
export const VERIFY_MAX_CHUNKS = 100;

const dayVerdict = z.object({
  day: z.string(),
  ok: z.boolean(),
  /** `archived`, or `not archived` (not yet due, or a gap after archived days). */
  status: z.enum(["archived", "not archived"]),
  rows: z.number(),
  chunks: z.number(),
  why: z.string().nullable(),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a UTC day, YYYY-MM-DD");

export const auditVerify = defineOperation({
  name: "audit.verify",
  description:
    "Verify the audit archive's hash chain for a range of UTC days (at most 31): every archived object is read fresh from R2 and re-hashed from the previous day's root, and each day's root and link are checked against D1's records. A missing, altered, added or reordered row, a missing object or a missing day is reported with the day and why. Reports verdicts only, never row contents. The archive holds every org's machine rows, so any org admin may verify it.",
  risk: "read",
  actors: ["human"],
  permission: "admin",
  input: z.object({ orgId: z.string().min(1), from: day, to: day }),
  output: z.object({
    ok: z.boolean(),
    days: z.array(dayVerdict),
    /** The call stopped at its object cap: verify again from this day. */
    nextDay: z.string().nullable(),
  }),
  async handler(input, ctx) {
    if (input.to < input.from) throw new OperationError("invalid_input", "`to` is before `from`");
    const span = (Date.parse(input.to) - Date.parse(input.from)) / 86_400_000 + 1;
    if (span > VERIFY_MAX_DAYS) {
      throw new OperationError("invalid_input", `at most ${VERIFY_MAX_DAYS} days in one call`);
    }
    const store = ctx.services.runArchive;
    if (!store) throw new OperationError("unavailable", "the archive isn't bound here");
    // The days (and the one before, for its root) and their chunks, by primary key ranges.
    const [days, chunks, firstEver] = await Promise.all([
      ctx.db
        .selectFrom("core_audit_archives")
        .selectAll()
        .where("day", ">=", prevDay(input.from))
        .where("day", "<=", input.to)
        .orderBy("day")
        .execute(),
      ctx.db
        .selectFrom("core_audit_archive_chunks")
        .selectAll()
        .where("day", ">=", input.from)
        .where("day", "<=", input.to)
        .orderBy("day")
        .orderBy("seq")
        .limit(VERIFY_MAX_CHUNKS + 1)
        .execute(),
      ctx.db
        .selectFrom("core_audit_archives")
        .select(sql<string | null>`min(day)`.as("day"))
        .executeTakeFirst(),
    ]);
    const byDay = new Map(days.map((d) => [d.day, d]));
    const out: z.infer<typeof dayVerdict>[] = [];
    let read = 0;
    let stoppedAt: string | null = null;
    for (let d = input.from; d <= input.to; d = nextDay(d)) {
      const rec = byDay.get(d);
      if (!rec) {
        // Not archived: fine once no later day is (not due yet); a gap otherwise.
        const later = days.some((x) => x.day > d);
        out.push({
          day: d,
          ok: !later,
          status: "not archived",
          rows: 0,
          chunks: 0,
          why: later ? "a later day is archived, so this one is missing" : null,
        });
        continue;
      }
      const theirs = chunks.filter((c) => c.day === d);
      if (read + rec.chunks > VERIFY_MAX_CHUNKS || theirs.length < rec.chunks) {
        if (out.length === 0) {
          throw new OperationError(
            "invalid_input",
            `${d} alone has more objects than one call reads`,
          );
        }
        stoppedAt = d;
        break;
      }
      const result = await verifyDay(
        rec,
        byDay.get(prevDay(d)) ?? null,
        firstEver?.day === d,
        theirs,
      );
      read += theirs.length;
      out.push({ day: d, status: "archived", rows: rec.rows, chunks: rec.chunks, ...result });
    }
    return { ok: out.every((x) => x.ok), days: out, nextDay: stoppedAt };

    async function verifyDay(
      rec: (typeof days)[number],
      before: (typeof days)[number] | null,
      first: boolean,
      theirs: typeof chunks,
    ): Promise<{ ok: boolean; why: string | null }> {
      const fail = (why: string) => ({ ok: false, why });
      if (first ? rec.prev_root !== GENESIS : before === null) {
        return fail(
          first ? "the first day doesn't chain from genesis" : "the day before isn't archived",
        );
      }
      if (before && rec.prev_root !== before.root)
        return fail("doesn't chain from the day before's root");
      if (theirs.length !== rec.chunks)
        return fail(`${theirs.length} objects recorded, ${rec.chunks} counted`);
      let prev = rec.prev_root;
      let rows = 0;
      for (const [i, c] of theirs.entries()) {
        if (c.seq !== i + 1) return fail(`object ${i + 1} is missing from the records`);
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
        rows += check.rows;
      }
      if (rows !== rec.rows) return fail(`${rows} rows in the objects, ${rec.rows} recorded`);
      if (prev !== rec.root) return fail("the root doesn't match the last row's hash");
      return { ok: true, why: null };
    }
  },
});
