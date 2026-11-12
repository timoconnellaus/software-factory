// Pins the web timeline's wording (spec wi-4, criterion 9): for every operation in the label table,
// plus the held, refused, failed, merged and gate-note rules, the rendered label, detail line,
// note and dot. Written against the timeline before its wording moved to @software-factory/timeline,
// and kept unchanged after, so "unchanged" is checked against the old behaviour.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "#/components/timeline";
import { clock } from "#/lib/format";
import type { TimelineEntry, WorkItemDetail } from "#/lib/ops";

const AT = "2026-11-10T09:58:00.000Z";

function entry(operation: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: `aud_${operation}`,
    at: AT,
    operation,
    actorType: "agent",
    actorId: "foreman",
    decision: "n/a",
    outcome: "ok",
    reason: "autonomy policy balanced",
    pendingActionId: null,
    result: null,
    ...over,
  };
}

/** Each rendered row as one line: dot, then its text with the clock masked. */
function rows(entries: TimelineEntry[], gates: WorkItemDetail["gates"] = []): string[] {
  const html = renderToStaticMarkup(<Timeline entries={entries} gates={gates} me="usr_me" />);
  return [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(([, li = ""]) => {
    const dot = /data-status="([a-z]+)"/.exec(li)?.[1];
    const text = li
      .replace(/<div class="text-muted-foreground">/, " | ")
      .replace(/<[^>]+>/g, "")
      .replaceAll("&#x27;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&")
      .replace(clock(AT), "<clock>")
      .replace(/\s+/g, " ")
      .trim();
    return `[${dot}] ${text}`;
  });
}

// One entry per key of the label table, with the result each journals (a detail where it has one).
const EVERY_OPERATION: TimelineEntry[] = [
  entry("workItem.create", {
    actorType: "human",
    actorId: "usr_me",
    result: { outcome: "created" },
  }),
  entry("workItem.triage", { result: { size: "small", reason: "One component" } }),
  entry("workItem.enterStage", { result: { stage: "build" } }),
  entry("workItem.finish"),
  entry("workItem.cancel", { actorType: "human", actorId: "usr_other" }),
  entry("spec.propose"),
  entry("spec.accept"),
  entry("spec.commit", { result: { path: "docs/specs/wi-1.md" } }),
  entry("spec.approve", { actorType: "human", actorId: "usr_me" }),
  entry("spec.requestChanges", { actorType: "human", actorId: "usr_me" }),
  entry("question.ask", { result: { questionIds: ["q_1", "q_2"] } }),
  entry("question.answer", { actorType: "human", actorId: "usr_me" }),
  entry("question.acceptDefaults", { actorType: "human", actorId: "usr_me" }),
  entry("question.escalate"),
  entry("workItem.awaitQuestions"),
  entry("job.enqueue"),
  entry("job.claim", { actorType: "runner", actorId: "rnr_1" }),
  entry("run.handBack", { actorType: "runner", actorId: "rnr_1" }),
  entry("run.release", { actorType: "runner", actorId: "rnr_1" }),
  entry("run.expire", { actorType: "system", actorId: "sweeper" }),
  entry("branch.ensure"),
  entry("branch.advance"),
  entry("pr.open", { result: { prNumber: 42 } }),
  entry("pr.merge"),
  entry("reviewPacket.record"),
  entry("review.merge", { actorType: "human", actorId: "usr_me" }),
  entry("review.sendBack", { actorType: "human", actorId: "usr_me" }),
  entry("approval.decide", { actorType: "human", actorId: "usr_me" }),
  entry("gate.escalate"),
  entry("incident.open"),
];

describe("the web timeline's wording", () => {
  it("labels every operation in the table", () => {
    expect(rows(EVERY_OPERATION)).toMatchInlineSnapshot(`
      [
        "[done] Work item created · you · <clock>",
        "[running] Triage · foreman · <clock> | Sized small. One component",
        "[running] Stage · foreman · <clock> | Entered build",
        "[running] Finished · foreman · <clock>",
        "[done] Cancelled · a person · <clock>",
        "[running] Spec proposed · foreman · <clock>",
        "[running] Spec accepted · foreman · <clock>",
        "[running] Spec committed · foreman · <clock> | docs/specs/wi-1.md",
        "[done] Spec approved · you · <clock>",
        "[done] Spec sent back to planning · you · <clock>",
        "[running] Questions asked · foreman · <clock> | 2 questions",
        "[done] Question answered · you · <clock>",
        "[done] Defaults accepted · you · <clock>",
        "[running] Questions escalated · foreman · <clock>",
        "[running] Waiting on answers · foreman · <clock>",
        "[running] Job queued · foreman · <clock>",
        "[running] Job claimed by a runner · runner rnr_1 · <clock>",
        "[running] Run handed back · runner rnr_1 · <clock>",
        "[running] Run released · runner rnr_1 · <clock>",
        "[running] Run expired · sweeper · <clock>",
        "[running] Branch created · foreman · <clock>",
        "[running] Branch advanced · foreman · <clock>",
        "[running] PR opened · foreman · <clock> | PR #42",
        "[running] Merged · foreman · <clock>",
        "[running] Review packet recorded · foreman · <clock>",
        "[done] Merge approved · you · <clock>",
        "[done] Sent back to build · you · <clock>",
        "[done] Approval decided · you · <clock>",
        "[running] Gate escalated · foreman · <clock>",
        "[running] Factory incident opened · foreman · <clock>",
      ]
    `);
  });

  it("says when a call was held, refused or failed, with its reason", () => {
    expect(
      rows([
        entry("pr.merge", {
          outcome: "review",
          decision: "review",
          reason: "merge needs a person",
        }),
        entry("pr.merge", { outcome: "failed", reason: "head moved" }),
        entry("spec.approve", {
          outcome: "forbidden",
          actorType: "human",
          actorId: "usr_x",
          reason: "not an approver",
        }),
        entry("workItem.triage", { outcome: "denied", reason: "policy floor" }),
        entry("run.expire", { outcome: "noop", reason: null }),
      ]),
    ).toMatchInlineSnapshot(`
      [
        "[waiting] Gate opened: Merge needs a person · foreman · <clock> | merge needs a person",
        "[failed] Merge · foreman · <clock> · failed | head moved",
        "[failed] Spec approved · a person · <clock> · forbidden | not an approver",
        "[failed] Triage · foreman · <clock> · denied | policy floor",
        "[idle] Run expired · foreman · <clock> · noop",
      ]
    `);
  });

  it("falls back to the raw name for an unknown operation, and drops a malformed detail", () => {
    expect(
      rows([
        entry("thing.unknown", { result: { size: "small" } }),
        entry("workItem.triage", { result: null }),
        entry("workItem.triage", { result: "small" }),
        entry("workItem.enterStage", { result: { stage: 3 } }),
        entry("pr.open", { result: { prNumber: "42" } }),
        entry("question.ask", { result: { questionIds: "q_1" } }),
        entry("workItem.create", { result: { outcome: "duplicate" } }),
      ]),
    ).toMatchInlineSnapshot(`
      [
        "[running] thing.unknown · foreman · <clock>",
        "[running] Triage · foreman · <clock>",
        "[running] Triage · foreman · <clock>",
        "[running] Stage · foreman · <clock>",
        "[running] PR opened · foreman · <clock>",
        "[running] Questions asked · foreman · <clock>",
        "[running] Work item created · foreman · <clock> | duplicate",
      ]
    `);
  });

  it("shows a decision's note and gate time instead of the gate check's reason", () => {
    const gates = [
      {
        id: "pa_1",
        kind: "spec",
        createdAt: "2026-11-10T09:00:00.000Z",
        decidedAt: AT,
        decidedBy: "usr_me",
        note: "Looks right",
      },
    ] as unknown as WorkItemDetail["gates"];
    expect(
      rows(
        [
          entry("spec.approve", { actorType: "human", actorId: "usr_me", reason: "human" }),
          entry("approval.decide", {
            actorType: "human",
            actorId: "usr_other",
            pendingActionId: "pa_1",
            reason: "human",
          }),
        ],
        gates,
      ),
    ).toMatchInlineSnapshot(`
      [
        "[done] Spec approved · you · <clock> · gate time 58m | Looks right",
        "[done] Approval decided · a person · <clock> · gate time 58m | Looks right",
      ]
    `);
  });
});
