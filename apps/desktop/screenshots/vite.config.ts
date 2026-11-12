// The screenshot harness's view build (ADR 0460): the app's own view, with bridge.ts swapped for
// the fixture door. `node screenshots/shoot.mjs` serves it and drives Chrome.
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import type { TerminalBridge, TerminalSize } from "../../../packages/runner-contract/src/index.ts";
import type { TerminalEvent } from "../src/shared/rpc.ts";

const bridge = resolve(import.meta.dirname, "../src/mainview/bridge.ts");
const fake = resolve(import.meta.dirname, "fake-bridge.ts");

const swapBridge: Plugin = {
  name: "swap-bridge",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!source.endsWith("bridge.ts")) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    return r?.id === bridge ? fake : null;
  },
};

/**
 * The relay's part for the harness (spec 42): `/__terminal/{open,send,close}` and an event stream,
 * bridging the tmux session `SF_SHOT_TMUX_SESSION` (on `SF_SHOT_TMUX_SOCKET`, default `sf-shot`, never
 * the factory's own socket) with runner-local's real control-mode bridge. It speaks the relay's
 * messages to the view (hello, size, output, ended) and takes the owner's input and resizes.
 */
const shotTerminal: Plugin = {
  name: "shot-terminal",
  configureServer(server) {
    const session = process.env.SF_SHOT_TMUX_SESSION;
    const socket = process.env.SF_SHOT_TMUX_SOCKET ?? "sf-shot";
    const clients = new Set<ServerResponse>();
    const bridges = new Map<string, TerminalBridge>();
    const emit = (e: TerminalEvent) => {
      for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const text = (id: string, m: unknown) => emit({ id, kind: "text", data: JSON.stringify(m) });
    server.middlewares.use("/__terminal", async (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(":\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}") as { id: string; data?: string; mode?: string };
      const reply = (v: unknown) => res.end(JSON.stringify(v));
      if (path === "/open") {
        if (!session) return reply({ ok: false, error: "no tmux session for the harness" });
        reply({ ok: true, error: null });
        const { openTmuxTerminal } = (await server.ssrLoadModule(
          resolve(import.meta.dirname, "../../../packages/runner-local/src/terminal.ts"),
        )) as typeof import("../../../packages/runner-local/src/terminal.ts");
        const mode = body.mode === "watch" ? "watch" : "type";
        emit({ id: body.id, kind: "open" });
        text(body.id, { t: "hello", mode, viewers: mode === "watch" ? 2 : 1, host: true });
        const bridge = await openTmuxTerminal({
          session,
          socket,
          size: null,
          onOutput: (b) =>
            emit({ id: body.id, kind: "bytes", base64: Buffer.from(b).toString("base64") }),
          onSize: (size) => text(body.id, { t: "size", size }),
          onExit: (reason) => text(body.id, { t: "ended", reason }),
        });
        bridges.set(body.id, bridge);
        await bridge.redraw();
        return;
      }
      const bridge = bridges.get(body.id);
      if (path === "/send" && bridge && body.data) {
        const m = JSON.parse(body.data) as { t: string; data?: string; size?: TerminalSize };
        if (m.t === "input" && m.data) await bridge.write(m.data);
        if (m.t === "resize" && m.size) await bridge.resize(m.size);
        return reply({ ok: true });
      }
      if (path === "/close" && bridge) {
        bridges.delete(body.id);
        await bridge.close();
        emit({ id: body.id, kind: "close", code: 1000, reason: "" });
        return reply({ ok: true });
      }
      reply({ ok: false });
    });
  },
};

export default defineConfig({
  plugins: [swapBridge, shotTerminal, react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  root: resolve(import.meta.dirname, "../src/mainview"),
  server: { port: 5741, strictPort: true },
  logLevel: "warn",
});
