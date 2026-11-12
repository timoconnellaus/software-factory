// The Live tab's Web terminal view (spec 35, ADR 0440): the job's real tmux pane in xterm.js, over a
// WebSocket to the job's relay. The runner's owner types and the pane follows their window's size;
// everyone else watches read-only at the pane's own size. xterm.js loads in the browser only.
import "@xterm/xterm/css/xterm.css";
import { Button } from "@software-factory/ui/components/button";
import { cn } from "@software-factory/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import {
  INITIAL_STATUS,
  statusText,
  TerminalClient,
  type TerminalStatus,
  terminalUrl,
} from "#/lib/web-terminal";

export function WebTerminal({ workItemId, runId }: { workItemId: string; runId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>(INITIAL_STATUS);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` reconnects.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    setStatus(INITIAL_STATUS);
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
        theme: { background: "#09090b" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      const ws = new WebSocket(terminalUrl(window.location, workItemId, runId));
      let fitNow = () => {};
      let fitted = false;
      const client = new TerminalClient(ws, term, (s) => {
        setStatus(s);
        // Watchers can't type: the terminal takes no keys from them.
        term.options.disableStdin = s.mode !== "type";
        // The owner's window size, once the relay has said they may type (it keeps it for the host).
        if (s.mode === "type" && !fitted) {
          fitted = true;
          fitNow();
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
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [workItemId, runId, attempt]);

  const over = status.phase === "ended" || status.phase === "closed";
  return (
    <div className="flex flex-col gap-2" data-testid="web-terminal">
      <div
        ref={box}
        className={cn("h-[420px] overflow-hidden rounded-lg bg-zinc-950 p-2", over && "opacity-60")}
      />
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span data-testid="web-terminal-status">{statusText(status)}</span>
        <span className="grow" />
        {status.phase === "closed" && (
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}
