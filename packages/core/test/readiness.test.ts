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
];

/** Nothing to act on: every one parks. */
const EMPTY: [string, string][] = [
  ["Fix it", ""],
  ["Bug", "   "],
  ["Login broken", "## Steps to reproduce\n\n## Expected\n\n## Actual\n"],
  ["New feature request", "<!-- Describe the feature -->\n## Description\n- [ ] \n"],
  ["See this", "https://example.com/thread/123"],
  ["Customer issue", "<https://support.example.com/t/42>"],
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
