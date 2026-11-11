// Spec 20, planning M1: the planning session's operations against real D1 (ADR 0300, 0301, 0340).
import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job, PlanningNews } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { type Actor, FOREMAN, planningReadyEvent } from "../src/index.ts";
import {
  delivered,
  first,
  newItem,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  uid,
  world,
} from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};
const pools = (light: number | null, heavy = 2) => ({
  max: heavy,
  inUse: 0,
  accepting: true,
  ...(light === null ? {} : { light: { max: light, inUse: 0 } }),
});

type W = Awaited<ReturnType<typeof world>>;

async function runner(w: W, name = "M5") {
  const r = await ok<{ runnerId: string }>("runner.register", { name }, w.human);
  return RUNNER_ACTOR(r.runnerId);
}

const claim = (actor: Actor, light: number | null = 6, heavy = 2) =>
  ok<{ job: Job | null }>(
    "job.claim",
    { claimId: uid("claim-"), manifest, capacity: pools(light, heavy) },
    actor,
  ).then((r) => r.job);

/** A work item in its spec stage with a planning session, its job claimed by `actor`. */
async function planning(w: W, actor: Actor, title = "Add CSV export") {
  const item = await newItem(w, title);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  const started = await ok<{ sessionId: string; jobId: string }>(
    "planning.start",
    { workItemId: item.workItemId },
    FOREMAN,
  );
  const job = await claim(actor);
  if (!job || job.jobId !== started.jobId) throw new Error("expected the planning job");
  return { item, job, sessionId: started.sessionId };
}

/** A planning job's call, as the channel's relay makes it (ADR 0350). */
const agent = <O = Record<string, unknown>>(
  actor: Actor,
  job: Job,
  op: string,
  input: Record<string, unknown> = {},
) => ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, actor);

const SPEC = {
  specMd:
    "## Goal\nExport the deals list as CSV [request].\n\n## Acceptance criteria\n1. Dates are ISO 8601 [assumption]",
  acceptanceCriteria: ["Dates export as ISO 8601"],
  assumptions: ["ISO 8601 dates in the org's time zone"],
  coverage: [{ category: "scope", status: "clear" }],
  clarifications: [],
  summary: "first draft",
};

describe("planning sessions (spec 20)", () => {
  it("starts a planning job in the light pool, only on a runner that reports one, with a fresh conversation", async () => {
    const w = await world();
    const old = await runner(w, "old");
    const item = await newItem(w);
    await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
    const started = await ok<{ sessionId: string; jobId: string }>(
      "planning.start",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    // Idempotent: a replayed start returns the same session.
    expect(
      (await ok<{ sessionId: string }>("planning.start", { workItemId: item.workItemId }, FOREMAN))
        .sessionId,
    ).toBe(started.sessionId);
    const job = await first<{ pool: string; stage: string }>(
      "SELECT pool, stage FROM core_jobs WHERE id = ?",
      started.jobId,
    );
    expect(job).toEqual({ pool: "light", stage: "planning" });
    // A runner with no light pool (an older host) takes no planning jobs (ADR 0301).
    expect(await claim(old, null)).toBeNull();
    const m5 = await runner(w);
    const claimed = await claim(m5);
    expect(claimed?.stage).toBe("planning");
    expect(claimed?.planning).toMatchObject({ sessionId: started.sessionId, resume: false });
    expect(claimed?.planning?.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
    const session = await first<{ runner_id: string }>(
      "SELECT runner_id FROM core_planning_sessions WHERE id = ?",
      started.sessionId,
    );
    expect(session.runner_id).toBe(m5.id);
  });

  it("lets the agent add, edit, reorder and delete questions in any order, each one in the planning log (criterion 3)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job } = await planning(w, m5);
    const one = await agent<{ questionIds: string[]; numbers: number[] }>(m5, job, "question.ask", {
      questions: [
        {
          kind: "single-choice",
          prompt: "Where does the export button go?",
          options: ["List toolbar", "Bulk-select menu"],
          default: "list toolbar",
          recommendation: "Matches the reports page.",
        },
      ],
    });
    const four = await agent<{ questionIds: string[]; numbers: number[] }>(
      m5,
      job,
      "question.ask",
      {
        questions: [
          { kind: "yes-no", prompt: "Respect current filters?", default: true },
          {
            kind: "multiple-choice",
            prompt: "Which columns?",
            options: ["Visible", "All", "Custom"],
            default: ["Visible", "Custom"],
          },
          { kind: "number", prompt: "Row cap?", default: 10000 },
          { prompt: "Filename?", default: "deals-YYYY-MM-DD" },
        ],
      },
    );
    expect(one.numbers).toEqual([1]);
    expect(four.numbers).toEqual([2, 3, 4, 5]);
    const [q1] = one.questionIds as [string];
    const [q2, q3, q4, q5] = four.questionIds as [string, string, string, string];
    await agent(m5, job, "question.update", {
      questionId: q3,
      patch: { prompt: "Which columns go in the file?", default: ["All"] },
    });
    await agent(m5, job, "question.reorder", { questionIds: [q5, q1] });
    await agent(m5, job, "question.delete", { questionId: q4, reason: "no cap needed" });
    await agent(m5, job, "question.focus", { questionId: q1 });

    const view = await ok<{
      questions: {
        id: string;
        prompt: string;
        kind: string;
        defaultValues: string[] | null;
        defaultAnswer: string | null;
        revision: number;
      }[];
      session: { focusedQuestionId: string | null };
    }>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.questions.map((q) => q.id)).toEqual([q5, q1, q2, q3]);
    const byId = new Map(view.questions.map((q) => [q.id, q]));
    expect(byId.get(q1)?.defaultValues).toEqual(["List toolbar"]);
    expect(byId.get(q2)?.defaultAnswer).toBe("Yes");
    expect(byId.get(q3)).toMatchObject({
      prompt: "Which columns go in the file?",
      defaultValues: ["All"],
      revision: 2,
    });
    expect(view.session.focusedQuestionId).toBe(q1);
    const log = await rows<{ type: string }>(
      "SELECT type FROM core_planning_events WHERE work_item_id = ? AND type LIKE 'question.%' ORDER BY id",
      item.workItemId,
    );
    expect(log.map((e) => e.type)).toEqual([
      "question.asked",
      "question.asked",
      "question.updated",
      "question.reordered",
      "question.deleted",
      "question.focused",
    ]);
    // Every change tells the live views (a planning.changed outbox message per call).
    const outbox = await rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_outbox WHERE kind = 'planning.changed' AND payload LIKE ?",
      `%${item.workItemId}%`,
    );
    expect(Number(outbox[0]?.n ?? 0) + delivered.flat().length).toBeGreaterThan(0);
    // A default that isn't an option is refused, as kim refuses it.
    const bad = await refusal(
      agent(m5, job, "question.ask", {
        questions: [{ kind: "single-choice", prompt: "x?", options: ["A", "B"], default: "C" }],
      }),
    );
    expect(bad.code).toBe("invalid_input");
  });

  it("brings answers, revisions and chat to the agent as news since its cursor, and waits by kim's rule", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job } = await planning(w, m5);
    const asked = await agent<{ questionIds: string[] }>(m5, job, "question.ask", {
      questions: [
        { kind: "yes-no", prompt: "Respect filters?", default: "Yes" },
        { prompt: "Filename?" },
      ],
    });
    const [q1, q2] = asked.questionIds as [string, string];
    // Nothing from a person yet: not due.
    let wait = await agent<PlanningNews & { due: boolean; recheckAt: string | null }>(
      m5,
      job,
      "planning.wait",
      {},
    );
    expect(wait.due).toBe(false);
    expect(wait.recheckAt).toBeNull();
    expect(
      (
        await first<{ status: string }>(
          "SELECT status FROM core_planning_sessions WHERE work_item_id = ?",
          item.workItemId,
        )
      ).status,
    ).toBe("idle");

    await ok("question.answer", { questionId: q1, answer: "Yes" }, w.human);
    // An answer with a question still open waits for a 15 s pause.
    wait = await agent(m5, job, "planning.wait", {});
    expect(wait.due).toBe(false);
    expect(Date.parse(wait.recheckAt ?? "")).toBeGreaterThan(Date.now() + 10_000);
    // A chat message is due at once (750 ms settle); idleMs 0 stands in for the pause here.
    await ok(
      "chat.send",
      { workItemId: item.workItemId, text: "Use the org's time zone" },
      w.human,
    );
    wait = await agent(m5, job, "planning.wait", { idleMs: 0 });
    // The settle after a chat message is 750 ms; wait for it.
    if (!wait.due) {
      await new Promise((r) => setTimeout(r, 800));
      wait = await agent(m5, job, "planning.wait", { idleMs: 0 });
    }
    expect(wait.due).toBe(true);
    expect(wait.events.map((e) => e.type)).toEqual(["answer.submitted", "chat.message"]);
    expect(wait.events[0]).toMatchObject({ answer: "Yes", acceptedDefault: true, number: 1 });
    expect(wait.openQuestions).toBe(1);

    // The cursor moved: news is empty until something else happens.
    let news = await agent<PlanningNews>(m5, job, "planning.news", { activity: "Read" });
    expect(news.events).toEqual([]);
    // A planning question's answer can be revised, with a note (kim's revisable answers).
    await ok("question.answer", { questionId: q1, answer: "No", note: "exports are raw" }, w.human);
    await ok("question.answer", { questionId: q2, answer: "deals.csv" }, w.human);
    news = await agent<PlanningNews>(m5, job, "planning.news", {});
    expect(news.events.map((e) => [e.type, "answer" in e ? e.answer : null])).toEqual([
      ["answer.revised", "No"],
      ["answer.submitted", "deals.csv"],
    ]);
    expect(news.events[0]).toMatchObject({ note: "exports are raw" });
    // An explicit cursor reads from there again.
    const again = await agent<PlanningNews>(m5, job, "planning.news", { cursor: 0 });
    expect(again.events.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a planning call for another work item (forbidden) and after the lease is gone (fenced) (criterion 8)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { job } = await planning(w, m5);
    const other = await newItem(w, "Something else");
    const forbidden = await refusal(
      agent(m5, job, "chat.reply", { workItemId: other.workItemId, text: "hi" }),
    );
    expect(forbidden.code).toBe("forbidden");
    const elsewhere = await refusal(
      agent(m5, job, "question.ask", {
        workItemId: other.workItemId,
        questions: [{ prompt: "?" }],
      }),
    );
    expect(elsewhere.code).toBe("forbidden");
    // Another runner can't use this job.
    const thief = await runner(w, "thief");
    expect((await refusal(agent(thief, job, "planning.news", {}))).code).toBe("forbidden");
    // A stale fencing token is fenced.
    const stale = await refusal(
      ok("planning.news", { jobId: job.jobId, fencingToken: job.lease.fencingToken + 1 }, m5),
    );
    expect(stale.code).toBe("fenced");
    // The session ends (the gate was decided): every call is fenced.
    await ok("planning.end", { workItemId: job.workItem.id, reason: "approved" }, FOREMAN);
    for (const op of ["planning.news", "planning.wait", "spec.revise", "chat.reply"]) {
      const input = op === "spec.revise" ? SPEC : op === "chat.reply" ? { text: "hi" } : {};
      expect((await refusal(agent(m5, job, op, input))).code).toBe("fenced");
    }
    // ...and the heartbeat tells the host to stop it.
    const hb = await ok<{ commands: { kind: string; jobId: string }[] }>(
      "runner.heartbeat",
      {
        manifest,
        capacity: pools(6),
        activeJobs: [{ jobId: job.jobId, fencingToken: job.lease.fencingToken }],
      },
      m5,
    );
    expect(hb.commands).toEqual([expect.objectContaining({ kind: "cancel", jobId: job.jobId })]);
  });

  it("keeps a revised spec's sections, opens the gate on ready, refuses revisions at the gate, and carries a change request into the same session (criteria 9, 10)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job } = await planning(w, m5);
    const asked = await agent<{ questionIds: string[] }>(m5, job, "question.ask", {
      questions: [{ kind: "yes-no", prompt: "Filters?", default: "Yes" }],
    });
    const revised = await agent<{ specId: string; version: number }>(m5, job, "spec.revise", SPEC);
    // Not ready while a blocking question is open.
    expect((await refusal(agent(m5, job, "planning.ready", {}))).code).toBe("conflict");
    await ok("question.answer", { questionId: asked.questionIds[0], answer: "Yes" }, w.human);
    const ready = await agent<{ specId: string; round: number }>(m5, job, "planning.ready", {});
    expect(ready).toEqual({ specId: revised.specId, round: 1 });
    const awaited = await ok<{ ready: boolean; specId: string; event: string }>(
      "planning.awaitReady",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    expect(awaited).toMatchObject({
      ready: true,
      specId: revised.specId,
      event: planningReadyEvent(item.workItemId, 1),
    });
    expect((await refusal(agent(m5, job, "spec.revise", SPEC))).code).toBe("conflict");
    const spec = await first<{ coverage: string; assumptions: string; body_md: string }>(
      "SELECT coverage, assumptions, body_md FROM core_specs WHERE id = ?",
      revised.specId,
    );
    expect(JSON.parse(spec.coverage)).toEqual([
      { category: "scope", status: "clear", questions: [] },
    ]);
    expect(spec.body_md).toContain("[assumption]");

    // Request changes: the note is a chat message from the approver in the same session.
    const noted = await ok<{ round: number }>(
      "planning.note",
      { workItemId: item.workItemId, note: "Say which time zone.", by: w.userId },
      FOREMAN,
    );
    expect(noted.round).toBe(2);
    const news = await agent<PlanningNews>(m5, job, "planning.news", {});
    // The answer before it, then the approver's note, in order.
    expect(news.events.at(-1)).toEqual(
      expect.objectContaining({ type: "chat.message", kind: "gate", text: "Say which time zone." }),
    );
    const again = await agent<{ version: number }>(m5, job, "spec.revise", {
      ...SPEC,
      summary: "time zone named",
    });
    expect(again.version).toBe(revised.version + 1);
    // Approval ends the session and frees its slot.
    await ok("planning.end", { workItemId: item.workItemId, reason: "approved" }, FOREMAN);
    const run = await first<{ status: string }>(
      "SELECT status FROM core_runs WHERE job_id = ?",
      job.jobId,
    );
    expect(run.status).toBe("cancelled");
  });

  it("yields the oldest idle session only when the light pool is full and nobody is there, and resumes the same conversation on the same runner (criterion 5)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job, sessionId } = await planning(w, m5);
    // The session waits in its Stop hook.
    await agent(m5, job, "planning.wait", {});
    // With room in the light pool it never yields, however long it has idled.
    await env.DB.prepare("UPDATE core_planning_sessions SET idle_since = ? WHERE id = ?")
      .bind(new Date(Date.now() - 10 * 60_000).toISOString(), sessionId)
      .run();
    const other = await newItem(w, "Triage me");
    await ok("branch.ensure", { workItemId: other.workItemId }, FOREMAN);
    await ok(
      "job.enqueue",
      { workItemId: other.workItemId, stage: "triage", role: "triage", prompt: "Size it" },
      FOREMAN,
    );
    expect((await agent<PlanningNews>(m5, job, "planning.wait", {})).yield).toBe(false);
    // Light pool full (max 1, the session holds it) and a light job queued: yield requested.
    expect(await claim(m5, 1)).toBeNull();
    const wait = await agent<PlanningNews>(m5, job, "planning.wait", {});
    expect(wait.yield).toBe(true);
    await agent(m5, job, "planning.yield", {});
    await ok(
      "run.handBack",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        outcome: "completed",
        artifactIds: [],
        branch: job.branch,
        result: { planning: "yielded" },
      },
      m5,
    );
    let session = await first<{ status: string; current_job_id: string | null }>(
      "SELECT status, current_job_id FROM core_planning_sessions WHERE id = ?",
      sessionId,
    );
    expect(session).toEqual({ status: "yielded", current_job_id: null });
    // The slot is free: the triage job is placed.
    expect((await claim(m5, 1))?.stage).toBe("triage");

    // A person answers: a resume of the same conversation, pinned to the same runner.
    await ok("chat.send", { workItemId: item.workItemId, text: "Still there?" }, w.human);
    session = await first(
      "SELECT status, current_job_id FROM core_planning_sessions WHERE id = ?",
      sessionId,
    );
    expect(session.status).toBe("starting");
    const elsewhere = await runner(w, "elsewhere");
    expect(await claim(elsewhere, 6)).toBeNull();
    const resumed = await claim(m5, 6);
    expect(resumed?.planning).toEqual({
      sessionId,
      sessionRef: job.planning?.sessionRef,
      resume: true,
    });
    // It sees everything since its cursor.
    const news = await agent<PlanningNews>(m5, resumed as Job, "planning.news", {});
    expect(news.events).toEqual([expect.objectContaining({ text: "Still there?" })]);
  });

  it("never holds a heavy slot: a build starts while 6 planning sessions sit idle (criterion 6)", async () => {
    const w = await world();
    const m5 = await runner(w);
    for (let i = 0; i < 6; i++) {
      const { job } = await planning(w, m5, `Plan ${i}`);
      await agent(m5, job, "planning.wait", {});
    }
    const build = await newItem(w, "Build me");
    await ok("branch.ensure", { workItemId: build.workItemId }, FOREMAN);
    await ok(
      "job.enqueue",
      { workItemId: build.workItemId, stage: "build", role: "implement", prompt: "Build" },
      FOREMAN,
    );
    expect((await claim(m5, 6, 2))?.stage).toBe("build");
    const inbox = await ok<{
      runners: { id: string; inUse: number; light: { inUse: number; max: number } | null }[];
    }>("inbox.list", {}, w.human);
    expect(inbox.runners.find((r) => r.id === m5.id)).toMatchObject({
      inUse: 1,
      light: { inUse: 6, max: 6 },
    });
  });

  it("continues on another runner: a fresh session from the planning record, the old one fenced (criterion 7)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job, sessionId } = await planning(w, m5);
    const asked = await agent<{ questionIds: string[] }>(m5, job, "question.ask", {
      questions: [{ prompt: "Which time zone?" }],
    });
    await agent(m5, job, "spec.revise", SPEC);
    await ok("question.answer", { questionId: asked.questionIds[0], answer: "UTC" }, w.human);
    await ok("chat.send", { workItemId: item.workItemId, text: "Keep it simple" }, w.human);
    const mini = await runner(w, "mini");
    const moved = await ok<{ sessionId: string; jobId: string }>(
      "planning.move",
      { workItemId: item.workItemId, runnerId: mini.id },
      w.human,
    );
    expect(moved.sessionId).not.toBe(sessionId);
    expect((await refusal(agent(m5, job, "planning.news", {}))).code).toBe("fenced");
    const fresh = await claim(mini);
    expect(fresh?.jobId).toBe(moved.jobId);
    expect(fresh?.planning?.resume).toBe(false);
    expect(fresh?.planning?.sessionRef).not.toBe(job.planning?.sessionRef);
    const prompt = fresh?.harness.prompt ?? "";
    expect(prompt).toContain("Which time zone?");
    expect(prompt).toContain('"UTC"');
    expect(prompt).toContain("Keep it simple");
    expect(prompt).toContain("Export the deals list as CSV [request]");
    // The old session is closed as moved.
    expect(
      (
        await first<{ status: string }>(
          "SELECT status FROM core_planning_sessions WHERE id = ?",
          sessionId,
        )
      ).status,
    ).toBe("moved");
  });

  it("never bulk-accepts security or irreversible planning questions (criterion 11)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job } = await planning(w, m5);
    await agent(m5, job, "question.ask", {
      questions: [
        { prompt: "Retention?", default: "30 days", domain: "security" },
        { prompt: "Drop the old table?", default: "Yes", kind: "yes-no", irreversible: true },
        { prompt: "Name?", default: "deals" },
      ],
    });
    const accepted = await ok<{ accepted: string[]; skipped: { why: string }[] }>(
      "question.acceptDefaults",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.skipped.map((s) => s.why).sort()).toEqual([
      "irreversible questions are answered one by one",
      "security & privacy questions are answered one by one",
    ]);
  });

  it("tells the agent who has the Planning view open, and announces planning once the first draft is in (criterion 1)", async () => {
    const w = await world();
    const m5 = await runner(w);
    const { item, job } = await planning(w, m5);
    await ok("planning.presence", { workItemId: item.workItemId, open: true }, w.human);
    let news = await agent<PlanningNews>(m5, job, "planning.news", {});
    expect(news.present).toEqual(["Tim"]);
    expect(news.events).toEqual([expect.objectContaining({ type: "presence.changed" })]);
    await ok("planning.presence", { workItemId: item.workItemId, open: false }, w.human);
    news = await agent<PlanningNews>(m5, job, "planning.news", {});
    expect(news.present).toEqual([]);

    await agent(m5, job, "spec.revise", SPEC);
    await agent(m5, job, "question.ask", { questions: [{ prompt: "Filename?" }] });
    await agent(m5, job, "planning.wait", {});
    const inbox = await ok<{ planning: { workItemId: string; openQuestions: number }[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(inbox.planning).toEqual([
      expect.objectContaining({ workItemId: item.workItemId, openQuestions: 1 }),
    ]);
  });

  it("keeps V1's answer-once rule for questions the Workflow asked", async () => {
    const w = await world();
    const item = await newItem(w);
    const asked = await ok<{ questionIds: string[] }>(
      "question.ask",
      { workItemId: item.workItemId, questions: [{ prompt: "Which?", defaultAnswer: "A" }] },
      FOREMAN,
    );
    await ok("question.answer", { questionId: asked.questionIds[0], answer: "A" }, w.human);
    const again = await refusal(
      ok("question.answer", { questionId: asked.questionIds[0], answer: "B" }, w.human),
    );
    expect(again.code).toBe("conflict");
  });
});
