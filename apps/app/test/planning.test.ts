// The Planning tab (spec 20): its live stream route. The panes' logic is tested in packages/client.
import { describe, expect, it } from "vitest";
import type { EngineRpc } from "#/server/engine";
import { handlePlanningLive, LIVE_PATH } from "#/server/planning-live";
import { recordingEngine, signIn, testEnv } from "./helpers.ts";

const ITEM = `wi_${"a".repeat(32)}`;

describe("the Planning tab's live stream", () => {
  it("proxies the engine's Server-Sent Events as the signed-in person, and nobody else", async () => {
    const asked: { workItemId: string; actor: unknown }[] = [];
    const { engine } = recordingEngine();
    const live: EngineRpc = {
      ...engine,
      async planningStream(workItemId, options) {
        asked.push({ workItemId, actor: options.actor });
        if (workItemId !== ITEM) {
          return { ok: false, error: { code: "not_found", message: "no work item" } };
        }
        const body = new TextEncoder().encode('event: changed\ndata: {"seq":1}\n\n');
        return {
          ok: true,
          stream: new ReadableStream({
            start(c) {
              c.enqueue(body);
              c.close();
            },
          }),
        };
      },
    };
    const appEnv = testEnv(live);
    const url = `http://localhost/api/work/${ITEM}/planning/live`;
    expect(LIVE_PATH.exec(new URL(url).pathname)?.[1]).toBe(ITEM);
    const anonymous = await handlePlanningLive(appEnv, new Request(url), ITEM);
    expect(anonymous.status).toBe(401);
    const { user, headers } = await signIn(appEnv, "timoconnellaus");
    const ok = await handlePlanningLive(appEnv, new Request(url, { headers }), ITEM);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/event-stream");
    expect(await ok.text()).toContain("event: changed");
    expect(asked[0]).toEqual({ workItemId: ITEM, actor: { type: "human", id: user.id } });
    const other = `wi_${"b".repeat(32)}`;
    const missing = await handlePlanningLive(appEnv, new Request(url, { headers }), other);
    expect(missing.status).toBe(404);
  });
});
