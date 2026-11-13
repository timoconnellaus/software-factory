// The web terminal (spec 35, ADR 0440). `run.terminal.attach` is how a person opens a running job's
// terminal from the Live tab: it decides whether they may type (the owner of the run's runner, as
// with steering: it runs on their machine with their model credential, ADR 0023, 0038) or only
// watch, and records the attach. `run.terminal.detach` stamps its close. `run.terminal.host` is the
// runner host's fenced check before sf-engine holds its `terminal` call on the job's relay.
import { TERMINAL_TICKET_TTL_MS } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { idPattern, newId } from "../ids.ts";
import { defineOperation } from "../operation.ts";
import { ACTIVE, loadRunForItem, runId, terminalVerdict } from "./live.ts";
import { fencingToken, jobId, requireWorkItem, workItemId } from "./shared.ts";

const attachId = z.string().regex(idPattern("terminalAttach"), "a terminal attach id (ta_…)");

export const runTerminalAttach = defineOperation({
  name: "run.terminal.attach",
  description:
    "Open a live run's terminal in the dashboard (spec 35, ADR 0440). The owner of the run's runner gets mode `type` (they may type into it); every other member of the org gets `watch` (read-only, enforced by the relay). Each attach is recorded with who, when and the mode. Refused for an ended run or a runner that can't share its terminal.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, runId }),
  output: z.object({
    attachId: z.string(),
    runId: z.string(),
    jobId: z.string(),
    mode: z.enum(["type", "watch"]),
  }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const run = await loadRunForItem(ctx, item.id, input.runId);
    if (!run) throw new OperationError("not_found", "no such run on this work item");
    const verdict = terminalVerdict(run, ctx.actor.id);
    if (!verdict.allowed || !verdict.mode) {
      const code = ACTIVE.includes(run.status) ? "unavailable" : "conflict";
      throw new OperationError(code, verdict.reason ?? "can't open this run's terminal");
    }
    const id = newId("terminalAttach");
    ctx.write(
      ctx.db.insertInto("core_run_terminal_attaches").values({
        id,
        run_id: run.id,
        work_item_id: item.id,
        user_id: ctx.actor.id,
        mode: verdict.mode,
        opened_at: ctx.now,
        closed_at: null,
      }),
    );
    ctx.change({ entity: "run_terminal_attach", id, after: { runId: run.id, mode: verdict.mode } });
    return { attachId: id, runId: run.id, jobId: run.job_id, mode: verdict.mode };
  },
});

export const runTerminalDetach = defineOperation({
  name: "run.terminal.detach",
  description:
    "Record that a person's web terminal on a run closed (spec 35, ADR 0440). The job's relay calls it, as that person, when their socket goes. Only their own attach; closing one twice changes nothing.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, attachId }),
  output: z.object({ closed: z.boolean() }),
  async handler(input, ctx) {
    const item = requireWorkItem(ctx);
    const row = await ctx.db
      .selectFrom("core_run_terminal_attaches")
      .select(["id", "user_id", "closed_at"])
      .where("id", "=", input.attachId)
      .where("work_item_id", "=", item.id)
      .executeTakeFirst();
    if (!row || row.user_id !== ctx.actor.id) {
      throw new OperationError("not_found", "no such terminal attach");
    }
    if (row.closed_at) return { closed: false };
    ctx.write(
      ctx.db
        .updateTable("core_run_terminal_attaches")
        .set({ closed_at: ctx.now })
        .where("id", "=", row.id)
        .where("closed_at", "is", null),
    );
    ctx.change({ entity: "run_terminal_attach", id: row.id, after: { closed: true } });
    return { closed: true };
  },
});

export const runTerminalHost = defineOperation({
  name: "run.terminal.host",
  description:
    "The runner host's check before it waits for a web terminal viewer on one of its live jobs (ADR 0440): the job's run and work item. Fenced: a stale token is refused; another runner's job and an ended run are refused.",
  risk: "read",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({ jobId, fencingToken }),
  output: z.object({ runId: z.string(), workItemId: z.string() }),
  async handler(input, ctx) {
    const run = await ctx.db
      .selectFrom("core_runs")
      .select(["id", "runner_id", "status", "work_item_id"])
      .where("job_id", "=", input.jobId)
      .executeTakeFirst();
    if (!run) throw new OperationError("not_found", `no run for job ${input.jobId}`);
    if (run.runner_id !== ctx.actor.id) {
      throw new OperationError("forbidden", "this job belongs to another runner");
    }
    if (!ACTIVE.includes(run.status)) throw new OperationError("conflict", `run is ${run.status}`);
    return { runId: run.id, workItemId: run.work_item_id };
  },
});

export const runTerminalCloseStale = defineOperation({
  name: "run.terminal.closeStale",
  description:
    "The runner host's channel closes the run's terminal attaches that its relay no longer has (spec 44): an attach opened longer ago than a viewer ticket lives, whose viewer the relay doesn't hold, was left open by a deploy or a crash. Without this, a stale attach would wake the relay on every poll. Fenced; audited only when it closes something.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  audit: { changesOnly: true },
  input: z.object({
    jobId,
    fencingToken,
    /** Attaches opened before this are stale when the relay holds no viewer. */
    before: z.string().datetime(),
  }),
  output: z.object({ closed: z.number() }),
  async handler(input, ctx) {
    const run = await ctx.db
      .selectFrom("core_runs")
      .select(["id", "runner_id"])
      .where("job_id", "=", input.jobId)
      .executeTakeFirst();
    if (!run) throw new OperationError("not_found", `no run for job ${input.jobId}`);
    if (run.runner_id !== ctx.actor.id) {
      throw new OperationError("forbidden", "this job belongs to another runner");
    }
    // Clamped here, whatever the caller says: only attaches older than twice a viewer ticket's
    // life, which an admitted viewer always connects within (review of #172).
    const cutoff = new Date(Date.parse(ctx.now) - 2 * TERMINAL_TICKET_TTL_MS).toISOString();
    // biome-ignore lint/complexity/useMathMinMax: the earlier of two ISO timestamps (strings)
    const before = input.before < cutoff ? input.before : cutoff;
    // core_run_terminal_attaches_open_idx: the run's open attaches only.
    const stale = await ctx.db
      .selectFrom("core_run_terminal_attaches")
      .select("id")
      .where("run_id", "=", run.id)
      .where("closed_at", "is", null)
      .where("opened_at", "<", before)
      .limit(50)
      .execute();
    for (const row of stale) {
      ctx.write(
        ctx.db
          .updateTable("core_run_terminal_attaches")
          .set({ closed_at: ctx.now })
          .where("id", "=", row.id)
          .where("closed_at", "is", null),
      );
      ctx.change({
        entity: "run_terminal_attach",
        id: row.id,
        after: { closed: true, stale: true },
      });
    }
    return { closed: stale.length };
  },
});
