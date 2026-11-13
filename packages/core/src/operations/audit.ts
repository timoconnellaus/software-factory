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

/**
 * One day's verdict. No row or object counts: the archive holds every org's machine rows, so an
 * org admin learns whether the chain is whole, not how busy other orgs were.
 */
const dayVerdict = z.object({
  day: z.string(),
  ok: z.boolean(),
  /**
   * `archived`; `before the archive` (earlier than its first day: nothing to archive); `not yet`
   * (after its last day: not due or not reached yet); `missing` (between archived days: a gap).
   */
  status: z.enum(["archived", "before the archive", "not yet", "missing"]),
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
    const [days, chunks, bounds] = await Promise.all([
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
        .select([sql<string | null>`min(day)`.as("first"), sql<string | null>`max(day)`.as("last")])
        .executeTakeFirst(),
    ]);
    const byDay = new Map(days.map((d) => [d.day, d]));
    const first = bounds?.first ?? null;
    const last = bounds?.last ?? null;
    // The chunk read stopped at its cap: from the first day it cut into, the records are partial.
    const cutDay =
      chunks.length > VERIFY_MAX_CHUNKS ? (chunks[VERIFY_MAX_CHUNKS]?.day ?? null) : null;
    const listed = chunks.slice(0, VERIFY_MAX_CHUNKS);
    const out: z.infer<typeof dayVerdict>[] = [];
    let stoppedAt: string | null = null;
    for (let d = input.from; d <= input.to; d = nextDay(d)) {
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
      if (cutDay !== null && d >= cutDay) {
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
        first === d,
        listed.filter((c) => c.day === d),
      );
      out.push({ day: d, status: "archived", ...result });
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
      if (theirs.length !== rec.chunks) {
        return fail(`${rec.chunks} objects counted for the day, ${theirs.length} recorded`);
      }
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
