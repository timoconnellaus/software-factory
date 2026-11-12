// The ClientHub answers the desktop app's keepalive without waking (AGENTS.md, Cloudflare cost, rule 6).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClientHub } from "../src/client-hub.ts";
import { clientHub } from "../src/client-hub.ts";

describe("ClientHub", () => {
  it("answers ping with pong through the runtime's auto-response", async () => {
    const hub = clientHub(env, "usr_ping");
    await runInDurableObject(hub, async (_instance: ClientHub, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe("ping");
      expect(pair?.response).toBe("pong");
    });
    const res = await hub.fetch("https://hub/", { headers: { upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    const messages: string[] = [];
    const pong = new Promise<void>((resolve) =>
      ws.addEventListener("message", (e) => {
        messages.push(String(e.data));
        if (e.data === "pong") resolve();
      }),
    );
    ws.send("ping");
    await pong;
    expect(messages).toEqual(['{"type":"hello"}', "pong"]);
    ws.close();
  });
});
