// A minimal Chrome DevTools Protocol client over the browser's page websocket, for the screenshot
// harness (shoot.mjs) and the behaviour tests (behave.mjs).
import { setTimeout as sleep } from "node:timers/promises";

/** A minimal CDP client over the browser's page websocket. */
export async function connect(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => {
          ws.onopen = r;
          ws.onerror = j;
        });
        let id = 0;
        const waiting = new Map();
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          const w = waiting.get(msg.id);
          if (w) {
            waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(msg.error.message));
            else w.resolve(msg.result);
          }
        };
        return {
          send: (method, params = {}) =>
            new Promise((resolve, reject) => {
              const n = ++id;
              waiting.set(n, { resolve, reject });
              ws.send(JSON.stringify({ id: n, method, params }));
            }),
          close: () => ws.close(),
        };
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error("Chrome didn't start");
}
