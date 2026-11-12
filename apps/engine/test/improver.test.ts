// Spec 09 M3: the improver's hourly pass (ADR 0373).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runImprover } from "../src/index.ts";
import { BALANCED, first, ok, world } from "./helpers.ts";

const ON = { ...BALANCED, improve: { enabled: true, trialSize: 3 } };

async function finishedItems(w: Awaited<ReturnType<typeof world>>, n: number) {
  for (let i = 0; i < n; i++) {
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: `Item ${i}` },
      w.human,
    );
    await env.DB.prepare("UPDATE core_work_items SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), item.workItemId)
      .run();
  }
}

describe("the improver's pass", () => {
  it("starts a trial when recent work all passed first time, and only with improve on", async () => {
    const off = await world(BALANCED);
    await finishedItems(off, 5);
    const on = await world(ON);
    await finishedItems(on, 5);
    await runImprover(env);
    const none = await first<{ id: string }>(
      "SELECT id FROM core_config_trials WHERE project_id = ?",
      off.projectId,
    );
    expect(none).toBeNull();
    const trial = await first<{ kind: string; summary: string; status: string }>(
      "SELECT kind, summary, status FROM core_config_trials WHERE project_id = ?",
      on.projectId,
    );
    expect(trial).toMatchObject({
      kind: "tier",
      summary: "Build on the light tier",
      status: "running",
    });
    // The audit says who: the improver, never a person.
    const audit = await first<{ actor_type: string }>(
      "SELECT actor_type FROM core_audit WHERE project_id = ? AND operation = 'config.trial.start'",
      on.projectId,
    );
    expect(audit?.actor_type).toBe("self-improve");
  });
});
