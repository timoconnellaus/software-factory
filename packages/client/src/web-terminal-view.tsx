// The web terminal's view (spec 35, ADR 0440), shared by sf-app's Live tab and the desktop app
// (spec 42, ADR 0500): the job's real tmux pane in xterm.js. The runner's owner types and the pane
// follows the view's size; everyone else watches read-only at the pane's own size. The socket comes
// from `connect()`: sf-app opens a WebSocket to its own route, the desktop a socket over its RPC.
// xterm.js loads in the browser only. This is packages/client's one React file: packages/ui can't
// depend on packages/client (client imports ui's types), and both apps already depend on client.
import "@xterm/xterm/css/xterm.css";
import { Button } from "@software-factory/ui/components/button";
import { cn } from "@software-factory/ui/lib/utils";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  INITIAL_STATUS,
  statusText,
  TerminalClient,
  type TerminalStatus,
  type ViewerSocket,
} from "./web-terminal.ts";

const DARK = { background: "#09090b" };
/** Claude Code and the shell draw ANSI colours meant for a dark screen; these keep them legible. */
const LIGHT = {
  background: "#ffffff",
  foreground: "#1c1c1e",
  cursor: "#1c1c1e",
  cursorAccent: "#ffffff",
  selectionBackground: "#c7d7fe",
  black: "#1c1c1e",
  red: "#c62828",
  green: "#2e7d32",
  yellow: "#8a6100",
  blue: "#1d4ed8",
  magenta: "#8e24aa",
  cyan: "#00796b",
  white: "#6e6e73",
  brightBlack: "#6e6e73",
  brightRed: "#d32f2f",
  brightGreen: "#388e3c",
  brightYellow: "#9a6b00",
  brightBlue: "#2563eb",
  brightMagenta: "#9c27b0",
  brightCyan: "#00897b",
  brightWhite: "#3a3a3e",
};

export type TerminalTheme = "dark" | "system";

function prefersDark(theme: TerminalTheme): boolean {
  if (theme === "dark") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function WebTerminal({
  connect,
  theme = "dark",
  autoFocus = false,
  className,
  screenClassName = "h-[420px]",
  footer,
  onStatus,
}: {
  /** Opens the socket to the job's relay; called again on Reconnect. */
  connect: () => ViewerSocket;
  /** `system` follows the light or dark appearance (the desktop); sf-app's Live tab stays dark. */
  theme?: TerminalTheme;
  /** Puts the keyboard in the terminal once it's live (the desktop's Open terminal). */
  autoFocus?: boolean;
  className?: string;
  /** The screen's size: a fixed height, or `flex-1 min-h-0` to fill its container. */
  screenClassName?: string;
  /** More of the status row, after the status (the desktop's fallback link). */
  footer?: ReactNode;
  onStatus?: (status: TerminalStatus) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>(INITIAL_STATUS);
  const [attempt, setAttempt] = useState(0);
  const [dark, setDark] = useState(() => prefersDark(theme));
  const latest = useRef({ connect, onStatus, autoFocus });
  latest.current = { connect, onStatus, autoFocus };

  useEffect(() => {
    if (theme !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [theme]);

  const termRef = useRef<{ options: { theme?: unknown } } | null>(null);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = dark ? DARK : LIGHT;
  }, [dark]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reconnects; the rest is read through `latest`.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    const report = (s: TerminalStatus) => {
      setStatus(s);
      latest.current.onStatus?.(s);
    };
    report(INITIAL_STATUS);
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        scrollback: 1_000,
        theme: prefersDark(theme) ? DARK : LIGHT,
      });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      const ws = latest.current.connect();
      let fitNow = () => {};
      let fitted = false;
      const client = new TerminalClient(ws, term, (s) => {
        report(s);
        // Watchers can't type: the terminal takes no keys from them.
        term.options.disableStdin = s.mode !== "type";
        // The owner's view size, once the relay has said they may type (it keeps it for the host).
        if (s.mode === "type" && !fitted) {
          fitted = true;
          fitNow();
          if (latest.current.autoFocus) term.focus();
        }
      });
      fitNow = () => {
        const size = fit.proposeDimensions();
        if (size) client.fit(size.cols, size.rows);
      };
      const typed = term.onData((data) => client.type(data));
      const observer = new ResizeObserver(() => fitNow());
      observer.observe(el);
      const ping = setInterval(() => {
        if (ws.readyState === 1) ws.send("ping");
      }, 30_000);
      cleanup = () => {
        clearInterval(ping);
        observer.disconnect();
        typed.dispose();
        client.close();
        term.dispose();
        termRef.current = null;
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [attempt, theme]);

  const over = status.phase === "ended" || status.phase === "closed";
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="web-terminal">
      <div
        ref={box}
        className={cn(
          "overflow-hidden rounded-lg p-2",
          !dark && "border border-black/10",
          over && "opacity-60",
          screenClassName,
        )}
        style={{ background: (dark ? DARK : LIGHT).background }}
      />
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span data-testid="web-terminal-status">{statusText(status)}</span>
        <span className="grow" />
        {footer}
        {status.phase === "closed" && (
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}
