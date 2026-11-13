// Spec 23 part A (ADR 0304 as amended 2026-11-12): the readiness pre-check is a floor for emptiness,
// not a judgement of clarity. It parks only an item with nothing to act on, or an exact duplicate of
// an open item from the same source, and only when no person released it (intake, MCP, agents).
// A parked item waits in the Backlog with a needs-info marker and a question to its requester;
// answering or editing re-runs the check and sends it on. A person gets an ignorable hint.
import { describe, expect, it } from "vitest";
import type { Surface } from "../src/actors.ts";
import { FOREMAN, invoke } from "../src/index.ts";
import { precheck } from "../src/readiness.ts";
import { deps, first, ok, POLICY, refusal, rows, world } from "./helpers.ts";

const INTAKE = { type: "intake" as const, id: "github" };
const CLEAR =
  "Issues labelled factory become work items in the backlog. When a labelled issue is opened, an item should appear within a minute.";

/** Ordinary requests, a title and a line (from the review of #117): every one passes. */
const ORDINARY: [string, string][] = [
  [
    "App crashes on startup on Windows 11",
    "Since the last release it closes right after the splash screen.",
  ],
  ["Let admins export the members table as CSV", "Finance asks for it every month."],
  ["Limit each token to 100 requests per minute", "One client hammered the API last night."],
  ["Retry failed webhooks with exponential backoff up to 5 times", "GitHub sometimes times out."],
  ["The save button is misaligned on mobile Safari", "It overlaps the cancel button on iPhone."],
  ["Upgrade React to 19", "We're two majors behind."],
  ["Dark mode", "Follow the system setting."],
  ["Typo on the pricing page", "It says 'anually'."],
  ["Search should ignore accents", "Searching 'cafe' doesn't find 'café'."],
  ["Add a 'last seen' column to the runners list", "So I can tell which Mac went quiet."],
  ["Emails go out twice", "Every invite email arrives two times."],
  ["Slow dashboard", "The overview takes 8 seconds to load with 500 items."],
  ["Remove the old v1 API", "Nothing has called it since March."],
  ["Fix the typo in the README header", ""],
  ["Make the sidebar collapsible", "Like Linear's."],
  ["Crash on save", "## What happened\nIt closes on save.\n- [x] I searched existing issues"],
  ["Logo", "Use the new one: [the logo](https://example.com/logo.svg)"],
  // Review of #160: a ticked item is a request, and `[x](url)` is a link with its text.
  ["Bug", "- [x] Crashes when saving a 2GB file"],
  ["Docs", "- [x](https://example.com/docs) is broken"],
  // Follow-up review: an unticked task is a task, and a reference-shaped line with words is text.
  ["Theme", "- [ ] Add dark mode\n- [ ] Follow the system setting"],
  ["API", "[note]: we should drop the v1 API"],
];

/** Nothing to act on: every one parks. */
const EMPTY: [string, string][] = [
  ["Fix it", ""],
  ["Bug", "   "],
  ["Login broken", "## Steps to reproduce\n\n## Expected\n\n## Actual\n"],
  ["New feature request", "<!-- Describe the feature -->\n## Description\n- [ ] \n"],
  ["See this", "https://example.com/thread/123"],
  ["Customer issue", "<https://support.example.com/t/42>"],
  // A template's checklist with its labels, and image-only bodies (review of #117).
  [
    "Bug report",
    "## Checklist\n- [ ] I searched existing issues\n- [ ] I read the docs\n* [ ] I can reproduce it",
  ],
  ["Screenshot", "![screenshot](https://example.com/s.png)"],
  ["Look", '<img src="https://example.com/s.png" alt="the bug" width="400">'],
  ["Crash", "## Screenshots\n![](https://example.com/a.png) ![b](https://example.com/b.png)"],
  // Review of #160: a URL with parentheses, and a reference-style image with its definition.
  ["Diagram", "![arch](https://example.com/wiki/File_(2).png)"],
  ["Ref", "![screenshot][1]\n\n[1]: https://example.com/s.png"],
];

type W = Awaited<ReturnType<typeof world>>;
const open = () => world({ ...POLICY, release: { agents: true } });
const fromIntake = (w: W, title: string, body: string, state = "queued") =>
  ok<{ workItemId: string; status: string; needsInfo?: { reason: string } }>(
    "workItem.create",
    { projectId: w.projectId, title, body, state, requesterUserId: w.userId, source: "github" },
    INTAKE,
  );
const item = (id: string) =>
  first<{ status: string; needs_info: string | null; body: string }>(
    "SELECT status, needs_info, body FROM core_work_items WHERE id = ?",
    id,
  );
const questionsOf = (id: string) =>
  rows<{ id: string; status: string; assignee_user_id: string; prompt: string }>(
    "SELECT id, status, assignee_user_id, prompt FROM core_questions WHERE work_item_id = ? ORDER BY created_at, id",
    id,
  );

/** Calls an operation from a given surface, as that surface's door would. */
async function from(
  surface: Surface,
  op: string,
  input: unknown,
  actor: { type: string; id: string },
) {
  const r = await invoke(deps, op, input, { actor: actor as never, origin: { surface } });
  if (r.status !== "ok") throw new Error(`${op} from ${surface}: ${JSON.stringify(r)}`);
  return r.output as { workItemId: string; status: string; needsInfo?: unknown };
}

describe("the readiness pre-check (spec 23)", () => {
  it("passes every ordinary request, and parks only one with nothing to act on", () => {
    for (const [title, body] of ORDINARY) {
      expect(precheck({ title, body, parentId: null }), title).toEqual({ ok: true });
    }
    for (const [title, body] of EMPTY) {
      expect(precheck({ title, body, parentId: null }), title).toEqual({
        ok: false,
        missing: ["content"],
      });
    }
    expect(precheck({ title: "x", body: "", parentId: "wi_parent" })).toEqual({ ok: true });
  });

  it("parks an empty request from intake without any run, asking its requester (criterion 1)", async () => {
    const w = await open();
    const created = await fromIntake(w, "Fix it", "");
    expect(created).toMatchObject({ status: "backlog", needsInfo: expect.any(Object) });
    const row = await item(created.workItemId);
    expect(JSON.parse(row.needs_info ?? "{}")).toMatchObject({
      waitingOn: w.userId,
      source: "precheck",
      heading: "queued",
      missing: ["content"],
    });
    const [q] = await questionsOf(created.workItemId);
    expect(q).toMatchObject({ status: "open", assignee_user_id: w.userId });
    expect(q?.prompt).toContain("nothing here to work on");
    expect(
      await rows("SELECT id FROM core_jobs WHERE work_item_id = ?", created.workItemId),
    ).toEqual([]);
  });

  it("parks an exact duplicate of an open item from the same source", async () => {
    const w = await open();
    await fromIntake(w, "Dark mode", "Follow the system setting.", "backlog");
    const dup = await fromIntake(w, "Dark mode", "Follow the system setting.");
    expect(dup.status).toBe("backlog");
    expect(JSON.parse((await item(dup.workItemId)).needs_info ?? "{}")).toMatchObject({
      missing: ["duplicate"],
    });
    // Different words, or another source, isn't a duplicate.
    expect(
      (await fromIntake(w, "Dark mode", "Follow the system setting, please.")).status,
    ).not.toBe("backlog");
  });

  it("goes on to where it was heading once answered, and asks again when the answer is only a link", async () => {
    const w = await open();
    const created = await fromIntake(w, "Fix it", "");
    const [q] = await questionsOf(created.workItemId);
    if (!q) throw new Error("expected a question");
    await ok("question.answer", { questionId: q.id, answer: "https://example.com/x" }, w.human);
    expect((await item(created.workItemId)).status).toBe("backlog");
    const second = (await questionsOf(created.workItemId))[1];
    if (!second) throw new Error("expected a second question");
    await ok(
      "question.answer",
      {
        questionId: second.id,
        answer: "The login page shows a blank screen after the last deploy.",
      },
      w.human,
    );
    const resumed = await item(created.workItemId);
    expect(resumed.needs_info).toBeNull();
    expect(["queued", "running"]).toContain(resumed.status);
    expect(resumed.body).toContain("blank screen");
  });

  it("re-checks when the request is edited, and lets a person move a parked item on", async () => {
    const w = await open();
    const a = await fromIntake(w, "Fix it", "", "ready");
    await ok("workItem.update", { workItemId: a.workItemId, body: CLEAR }, w.human);
    expect(await item(a.workItemId)).toMatchObject({ status: "ready", needs_info: null });
    expect((await questionsOf(a.workItemId))[0]?.status).toBe("withdrawn");

    const b = await fromIntake(w, "Fix it", "");
    expect(
      (await refusal(ok("workItem.release", { workItemId: b.workItemId }, FOREMAN))).code,
    ).toBe("conflict");
    const released = await ok<{ status: string; hint?: string }>(
      "workItem.release",
      { workItemId: b.workItemId },
      w.human,
    );
    expect(released.status).toBe("queued");
    expect(released.hint).toContain("triage will ask");
    expect((await item(b.workItemId)).needs_info).toBeNull();
  });

  it("counts a person by surface: the app, desktop, phone and CLI are a person; MCP, intake and agents aren't", async () => {
    const w = await open();
    const create = (surface: Surface) =>
      from(
        surface,
        "workItem.create",
        { projectId: w.projectId, title: "Fix it", body: "", state: "queued" },
        w.human,
      );
    for (const surface of ["app", "desktop", "mobile", "cli"] as const) {
      expect((await create(surface)).status, surface).not.toBe("backlog");
    }
    // An agent using a person's token over MCP is still an agent.
    const mcp = await create("mcp");
    expect(mcp).toMatchObject({ status: "backlog", needsInfo: expect.any(Object) });
    const intake = await from(
      "connector",
      "workItem.create",
      {
        projectId: w.projectId,
        title: "Fix it",
        body: "",
        state: "queued",
        requesterUserId: w.userId,
      },
      INTAKE,
    );
    expect(intake.status).toBe("backlog");
  });

  it("shows a person releasing an empty request a hint, and on the item", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string; status: string; hint?: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Fix it", body: "", state: "queued" },
      w.human,
    );
    expect(created.status).toBe("queued");
    expect(created.hint).toContain("little here to work on");
    const backlog = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Bug", body: "" },
      w.human,
    );
    const view = await ok<{ item: { readinessHint: string | null } }>(
      "workItem.get",
      { workItemId: backlog.workItemId },
      w.human,
    );
    expect(view.item.readinessHint).toContain("triage will ask");
  });
});

/** Puts an item in triage, as its Workflow does. */
const inTriage = (id: string) =>
  rows("UPDATE core_work_items SET stage = 'triage' WHERE id = ?", id);

/** Parks an item as Workflow instance `instance` would (`workItem.parkForInfo`). */
async function parkAs(workItemId: string, instance: string) {
  await inTriage(workItemId);
  const r = await invoke(
    deps,
    "workItem.parkForInfo",
    {
      workItemId,
      reason: "It doesn't say which issues",
      questions: [
        {
          prompt: "Which label marks an issue for the factory?",
          options: ["factory", "sf"],
          defaultAnswer: "factory",
        },
      ],
    },
    { actor: FOREMAN, origin: { surface: "workflow", workflowId: instance } },
  );
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return r.output;
}

describe("triage's parking and questions (spec 23 part B)", () => {
  it("parks only from the item's own Workflow, in triage (review of #125, 2)", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Issues", body: CLEAR, state: "queued" },
      w.human,
    );
    // Another instance: refused.
    await expect(parkAs(created.workItemId, `${created.workItemId}-r9`)).rejects.toThrow(
      /current Workflow, in triage/,
    );
    // Not in triage: refused.
    await rows("UPDATE core_work_items SET stage = 'build' WHERE id = ?", created.workItemId);
    await expect(
      invoke(
        deps,
        "workItem.parkForInfo",
        { workItemId: created.workItemId, reason: "x", questions: [{ prompt: "?" }] },
        { actor: FOREMAN, origin: { surface: "workflow", workflowId: created.workItemId } },
      ),
    ).rejects.toThrow(/current Workflow, in triage/);
  });

  it("stops parking at three cycles: a person decides, with everything asked (review of #125, 3)", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Issues", body: CLEAR, state: "queued" },
      w.human,
    );
    const id = created.workItemId;
    await rows("UPDATE core_work_items SET workflow_id = ? WHERE id = ?", `${id}-r3`, id);
    const parked = (await parkAs(id, `${id}-r3`)) as { questionIds: string[] };
    const marker = JSON.parse((await item(id)).needs_info ?? "{}");
    expect(marker).toMatchObject({ capped: true, reason: expect.stringContaining("3 times") });
    expect(marker.asked).toContain("Which label marks an issue for the factory?");
    // Answering doesn't send it on; a person releasing it does.
    await ok("question.answer", { questionId: parked.questionIds[0], answer: "factory" }, w.human);
    expect((await item(id)).status).toBe("backlog");
    expect(
      (await ok<{ status: string }>("workItem.release", { workItemId: id }, w.human)).status,
    ).toBe("queued");
  });

  it("parks an item triage found not actionable on a new Workflow generation, and answering re-releases it there", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Issues", body: CLEAR, state: "queued" },
      w.human,
    );
    const parked = (await parkAs(created.workItemId, created.workItemId)) as {
      status: string;
      questionIds: string[];
    };
    expect(parked.status).toBe("backlog");
    const row = await first<{
      status: string;
      workflow_id: string;
      pulled_at: string | null;
      needs_info: string;
    }>(
      "SELECT status, workflow_id, pulled_at, needs_info FROM core_work_items WHERE id = ?",
      created.workItemId,
    );
    expect(row).toMatchObject({
      status: "backlog",
      workflow_id: `${created.workItemId}-r2`,
      pulled_at: null,
    });
    expect(JSON.parse(row.needs_info)).toMatchObject({ source: "triage", heading: "queued" });
    const [q] = parked.questionIds;
    await ok("question.answer", { questionId: q, answer: "factory" }, w.human);
    const after = await first<{ status: string; body: string; needs_info: string | null }>(
      "SELECT status, body, needs_info FROM core_work_items WHERE id = ?",
      created.workItemId,
    );
    expect(after.needs_info).toBeNull();
    expect(["queued", "running"]).toContain(after.status);
    expect(after.body).toContain("factory");
    // The new run is the new generation.
    const starts = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.create' AND payload LIKE ?",
      `%${created.workItemId}-r2%`,
    );
    expect(starts).toHaveLength(1);
  });

  it("asks triage's questions into an open planning session", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Issues", body: CLEAR, state: "queued" },
      w.human,
    );
    const closed = await refusal(
      ok(
        "planning.seedQuestions",
        { workItemId: item.workItemId, questions: [{ prompt: "Which label?" }] },
        FOREMAN,
      ),
    );
    expect(closed.code).toBe("conflict");
    await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
    await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
    const seeded = await ok<{ questionIds: string[] }>(
      "planning.seedQuestions",
      {
        workItemId: item.workItemId,
        questions: [{ prompt: "Which label?", options: ["factory", "sf"] }],
      },
      FOREMAN,
    );
    const view = await ok<{ questions: { id: string; prompt: string; status: string }[] }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.questions).toEqual([
      expect.objectContaining({
        id: seeded.questionIds[0],
        prompt: "Which label?",
        status: "open",
      }),
    ]);
  });
});
