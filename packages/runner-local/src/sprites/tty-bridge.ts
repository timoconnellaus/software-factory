// The job's tmux pane on the host, bridged to Claude in its sprite (ADR 0460). The pane runs
// `sprite.sh`, which `exec`s this script with Node: it opens the sandbox's exec WebSocket with a TTY
// and pipes the pane's terminal through it, raw, both ways. So everything runner-local does with the
// pane works on a sprite unchanged: the trust dialog and the prompt pointer typed with `send-keys`,
// steering (ADR 0400), `tmux attach` to take over, the screen log, and the web terminal's tmux
// control-mode bridge (ADR 0440).
//
// The provider token is read from its 0600 file on the host and sent on the upgrade; it is never in
// an argv, an environment or the sprite. When the socket drops without an exit (a network blip, a
// sleeping laptop), the bridge reattaches to the same exec session, which kept running.
//
//   node tty-bridge.ts <runDir>/sprite-tty.json
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TtyBridgeConfig {
  /** The exec URL for the new command, with its TTY parameters. */
  url: string;
  /** `<api>/v1/sprites/<name>/exec`: a session id is appended to reattach. */
  attachBase: string;
  /** The provider token's file (0600). */
  tokenFile: string;
  /** How many times to reattach after a drop before giving up. */
  reattach?: number;
}

type WebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export interface TtyBridgeIo {
  stdin: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  stdout: NodeJS.WritableStream & {
    columns?: number;
    rows?: number;
    on(event: "resize", fn: () => void): unknown;
  };
  WebSocket?: WebSocketCtor;
  /** Tests: shorter waits between reattaches. */
  backoffMs?: number;
}

/** Runs the bridge until the command exits; resolves with its exit code. */
export function runTtyBridge(config: TtyBridgeConfig, io: TtyBridgeIo): Promise<number> {
  const WS = io.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const token = readFileSync(config.tokenFile, "utf8").trim();
  const headers = { authorization: `Bearer ${token}` };
  const maxReattach = config.reattach ?? 30;
  let sessionId: string | null = null;
  let ws: WebSocket | null = null;
  let attempts = 0;

  if (io.stdin.isTTY && io.stdin.setRawMode) io.stdin.setRawMode(true);
  const size = () => ({
    type: "resize",
    cols: io.stdout.columns ?? 80,
    rows: io.stdout.rows ?? 24,
  });

  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (io.stdin.isTTY && io.stdin.setRawMode) io.stdin.setRawMode(false);
      io.stdin.removeListener("data", onInput);
      try {
        ws?.close();
      } catch {}
      resolve(code);
    };
    const onInput = (chunk: Buffer | string) => {
      if (ws && ws.readyState === 1) ws.send(Buffer.from(chunk));
    };
    io.stdin.on("data", onInput);
    io.stdin.on("end", () => {});
    io.stdout.on("resize", () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(size()));
    });

    const open = (url: string) => {
      const socket = new WS(url, { headers });
      ws = socket;
      socket.binaryType = "arraybuffer";
      let exited = false;
      socket.addEventListener("open", () => {
        attempts = 0;
        socket.send(JSON.stringify(size()));
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              session_id?: string | number;
              exit_code?: number;
            };
            if (msg.type === "session_info" && msg.session_id !== undefined) {
              sessionId = String(msg.session_id);
            } else if (msg.type === "exit") {
              exited = true;
              finish(typeof msg.exit_code === "number" ? msg.exit_code : 0);
            }
          } catch {}
          return;
        }
        io.stdout.write(Buffer.from(event.data as ArrayBuffer));
      });
      socket.addEventListener("close", (event) => {
        if (done || exited) return;
        // A clean close with no session to come back to is the end of the command.
        if (event.code === 1000 && !sessionId) return finish(0);
        if (!sessionId || attempts >= maxReattach) return finish(event.code === 1000 ? 0 : 1);
        attempts++;
        const wait = Math.min(10_000, (io.backoffMs ?? 500) * attempts);
        setTimeout(() => {
          if (!done) open(`${config.attachBase}/${encodeURIComponent(sessionId ?? "")}`);
        }, wait);
      });
      socket.addEventListener("error", () => {});
    };
    open(config.url);
  });
}

const isMain = !!process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMain && process.argv[2]) {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as TtyBridgeConfig;
  runTtyBridge(config, { stdin: process.stdin, stdout: process.stdout }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`sprite bridge: ${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    },
  );
}
