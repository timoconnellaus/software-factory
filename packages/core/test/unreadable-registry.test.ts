// Fourth review of #185: an item whose pinned workflow can't be read does no work, from any caller.
// `invoke()` stops every call scoped to the item (by work item or by job) for agents and runners,
// except the allow-list. This pins the operations that find their item another way, each reviewed,
// so a new one can't be added without deciding how it stops.
import { describe, expect, it } from "vitest";
import { PINNED_ERROR_ALLOWED } from "../src/invoke.ts";
import { OPERATIONS } from "../src/registry.ts";

/** Scoped by their job: `resolveScope` finds the item from it, so `invoke()`'s stop applies. */
const BY_JOB = [
  "question.answerFromEdit",
  "question.update",
  "question.delete",
  "question.reorder",
  "question.focus",
  "spec.revise",
  "chat.reply",
  "planning.news",
  "artifact.add",
  "artifact.update",
  "artifact.delete",
  "artifact.show",
  "artifact.read",
  "design.pull",
  "design.preview",
  "planning.wait",
  "planning.yield",
  "planning.ready",
];
/** Find the item by repository or head and write `factory/verify` only through `postVerify`. */
const THROUGH_POST_VERIFY = ["verify.refresh", "main.observe"];
/** Do no work for an item: what they record or withdraw leaves its next step to the stop. */
const NO_WORK = {
  "protection.observe": "the repository's protection settings, not an item",
  "push.observe":
    "records a person's push and withdraws an approval; the item's next step is refused",
};

/**
 * Default-scoped, and their input names no item (no workItemId, jobId, pendingActionId or
 * questionId): each reviewed (fifth review of #185).
 */
const NO_ITEM = {
  "queue.pull": "starts released items; an item pins its version as it is pulled",
  "job.claim": "skips and cancels a job whose item can't be read (workflowUnreadable)",
  "config.trial.start": "a project's practice trial, not an item",
  "config.trial.resolve": "a project's practice trial, not an item",
  "skill.propose": "an org proposal a person decides",
  "workItem.create": "creates an item, which pins its version later",
  "cli.deviceStart": "device sign-in",
  "cli.devicePoll": "device sign-in",
  "desktop.authStart": "device sign-in",
  "desktop.authExchange": "device sign-in",
  "mobile.authStart": "device sign-in",
  "mobile.authExchange": "device sign-in",
  "runner.deviceStart": "device sign-in",
  "runner.devicePoll": "device sign-in",
  "runner.heartbeat": "the runner's own liveness and leases",
  "connector.receive": "an intake event that creates or routes items",
  "github.installation": "the App's installation",
  "audit.archiveHealth": "the audit archive's health",
};
const ITEM_KEYS = ["workItemId", "jobId", "pendingActionId", "questionId"];

describe("every non-read operation an agent, runner or intake can call is stopped for an unreadable item", () => {
  it("is scoped to the item, on the allow-list, or reviewed here", () => {
    const custom = OPERATIONS.filter(
      (o) =>
        o.actors.some((a) => a !== "human") &&
        o.risk !== "read" &&
        o.scope &&
        !(PINNED_ERROR_ALLOWED as readonly string[]).includes(o.name),
    )
      .map((o) => o.name)
      .sort();
    expect(custom).toEqual([...BY_JOB, ...THROUGH_POST_VERIFY, ...Object.keys(NO_WORK)].sort());
  });

  it("default-scoped operations that name no item are reviewed too", () => {
    const named = OPERATIONS.filter(
      (o) =>
        o.actors.some((a) => a !== "human") &&
        o.risk !== "read" &&
        !o.scope &&
        !(PINNED_ERROR_ALLOWED as readonly string[]).includes(o.name),
    )
      .filter((o) => {
        const shape = (o.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
        return !ITEM_KEYS.some((k) => k in shape);
      })
      .map((o) => o.name)
      .sort();
    expect(named).toEqual(Object.keys(NO_ITEM).sort());
  });

  it("the allow-list only reads, asks, waits, ends, re-resolves or lets a run under way finish", () => {
    expect([...PINNED_ERROR_ALLOWED].sort()).toEqual(
      [
        "question.ask",
        "question.escalate",
        "workItem.awaitQuestions",
        "workItem.finish",
        "workItem.cancel",
        "incident.open",
        "workItem.repinWorkflow",
        "run.handBack",
        "run.release",
        "run.expire",
        "run.reportEvents",
        "run.takeSteers",
        "lease.heartbeat",
        "lease.release",
        "mergeQueue.leave",
        "babysit.next",
        "workItem.markUnreadable",
      ].sort(),
    );
  });
});
