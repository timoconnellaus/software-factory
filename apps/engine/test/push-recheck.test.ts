// #190 review: an App push to a work item's branch that the engine hadn't recorded making is
// judged again after PUSH_RECHECK_MS. The outbox holds the second look until then (an immediate
// delivery leaves it), and the cron delivers it once due: a violation unless the engine made it.
import { env } from "cloudflare:workers";
import { GITHUB_INTAKE } from "@software-factory/connector-github";
import { FOREMAN } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import { deliverOutbox, retryOutbox } from "../src/outbox.ts";
import { all, first, github, ok, world } from "./helpers.ts";

describe("the second look at an App push the engine didn't record", () => {
  it("is held in the outbox until due, then judged a violation", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "A branch someone else moves" },
      w.human,
    );
    const { branch } = await ok<{ branch: string }>(
      "branch.ensure",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    const foreign = await github.push(w.repo, branch, undefined, ["src/hidden.ts"]);
    const seen = await ok<{ outcome: string; detail: string }>(
      "push.observe",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        ref: `refs/heads/${branch}`,
        before: "b".repeat(40),
        after: foreign,
        pusher: "software-factory-test[bot]",
        pusherIsApp: true,
      },
      GITHUB_INTAKE,
    );
    expect(seen.detail).toMatch(/checked again shortly/);
    const held = await first<{ id: string }>(
      "SELECT id FROM core_outbox WHERE kind = 'push.recheck' AND instr(payload, ?) > 0",
      foreign,
    );
    expect(held).not.toBeNull();
    // Delivered at once after the commit, as every message is: not yet due, so it stays.
    await deliverOutbox(env, [String(held?.id)]);
    expect(await first("SELECT id FROM core_outbox WHERE id = ?", held?.id)).not.toBeNull();
    // The cron's pass once it is due: judged, and gone from the outbox.
    await retryOutbox(env, new Date(Date.now() + 3 * 60_000));
    expect(await first("SELECT id FROM core_outbox WHERE id = ?", held?.id)).toBeNull();
    const judged = await all<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'push.observe' AND work_item_id = ? ORDER BY at",
      item.workItemId,
    );
    expect(judged.map((r) => JSON.parse(r.result).outcome)).toEqual(["ok", "violation"]);
    expect(JSON.parse(String(judged[1]?.result)).detail).toMatch(
      /neither the engine nor a run of #\d+ made/,
    );
  });
});
