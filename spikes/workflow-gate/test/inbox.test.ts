import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "./helpers";

const pendingId = `pa_${"a".repeat(32)}`;

describe("inbox", () => {
  it("lists a pending gate and approves it from the form", async () => {
    await env.DB.prepare(
      `INSERT INTO pending_actions (id, operation, risk, actor_type, actor_id, input, created_at)
       VALUES (?, 'pr.merge', 'merge', 'agent', 'foreman', '{}', ?)`,
    )
      .bind(pendingId, new Date().toISOString())
      .run();

    const page = await (await exports.default.fetch("http://factory.test/")).text();
    expect(page).toContain("Needs you (1)");
    expect(page).toContain(`action="/approvals/${pendingId}"`);

    const response = await exports.default.fetch(`http://factory.test/approvals/${pendingId}`, {
      method: "POST",
      body: new URLSearchParams({ decision: "approved", note: "<b>ok</b>" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(
      await rows("SELECT status, decided_by, note FROM pending_actions WHERE id = ?", pendingId),
    ).toEqual([{ status: "approved", decided_by: "local", note: "<b>ok</b>" }]);
    expect(await (await exports.default.fetch("http://factory.test/")).text()).toContain(
      "Needs you (0)",
    );
  });

  it("answers a refused call with its code", async () => {
    const response = await exports.default.fetch("http://factory.test/api/intake", {
      method: "POST",
      body: JSON.stringify({ source: "github" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_input" });
  });
});
