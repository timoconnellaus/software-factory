// A run's live terminal in the desktop app (spec 42, ADR 0530): the shared web terminal view
// (packages/client) on the main process's socket to the client door. Self-contained so the item side
// panel can host it as it is: `TerminalPanel` fills whatever box it's given; `TerminalDock` places it
// over the lower part of the page, resizable by its top edge, or over the whole window when expanded.
// The relay decides who types (ADR 0440): the runner's owner types, which takes the session over;
// everyone else watches. When the terminal can't be reached, one line says why, and the tmux command
// is behind "Attach from a terminal instead".
import type { TerminalStatus } from "@software-factory/client/web-terminal";
import { WebTerminal } from "@software-factory/client/web-terminal-view";
import { Button } from "@software-factory/ui/components/button";
import { Kbd } from "@software-factory/ui/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@software-factory/ui/components/popover";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Maximize2Icon, Minimize2Icon, SquareTerminalIcon, XIcon } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { bun, onTerminal } from "../bridge.ts";
import { openExternal } from "../lib/external.tsx";
import { op } from "../lib/op.ts";
import {
  CLOSE_CHORD_LABEL,
  closesDock,
  fallbackLine,
  stageLabel,
  type TerminalRun,
} from "../lib/terminal.ts";
import { RpcTerminalSocket, type TerminalRpc } from "../lib/terminal-socket.ts";

export type { TerminalRun };

/** The main process's terminal requests, as the shared socket wants them. */
const rpc: TerminalRpc = {
  open: (p) => bun.terminalOpen(p),
  send: (p) => bun.terminalSend(p),
  close: (p) => bun.terminalClose(p),
  subscribe: onTerminal,
};

/** The tmux command, for when the terminal can't open here. */
export function AttachInstead({ takeover }: { takeover: TerminalRun["takeover"] }) {
  if (!takeover) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-ink-muted text-xs underline-offset-2 hover:text-ink hover:underline"
          data-testid="attach-instead"
        >
          Attach from a terminal instead
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] gap-2 text-[13px]">
        <div className="font-medium">{takeover.label}</div>
        <pre className="m-0 mt-2 whitespace-pre-wrap rounded-md bg-selected p-2 font-mono text-xs">
          {takeover.hint}
        </pre>
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(takeover.hint)
                .then(() => toast.success("Copied"))
                .catch(() => toast.error("Couldn't copy"))
            }
          >
            Copy
          </Button>
          <span className="text-ink-muted text-xs">
            Run it in Terminal on the runner's Mac. Typing there takes the session over.
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The terminal itself, filling its box: a header, the screen, the status line. */
export function TerminalPanel({
  workItemId,
  run,
  expanded,
  onExpand,
  onClose,
  onMode,
}: {
  workItemId: string;
  run: TerminalRun;
  expanded?: boolean;
  onExpand?: () => void;
  onClose: () => void;
  /** Whether this person types or watches, once known (the dock leaves Esc to a typing session). */
  onMode?: (mode: "type" | "watch" | null) => void;
}) {
  // Whether this person may open it, and why not: `run.live`'s verdict, without its events.
  const verdict = useQuery({
    queryKey: ["terminal-verdict", workItemId, run.id],
    queryFn: async () =>
      (await op("run.live", { workItemId, runId: run.id, afterSeq: 2 ** 31 })).terminal,
    staleTime: 0,
    retry: false,
  });
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (waitingSince === null) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [waitingSince]);

  const onStatus = (s: TerminalStatus) => {
    setStatus(s);
    setWaitingSince((since) => (s.phase === "waiting" ? (since ?? Date.now()) : null));
  };
  const allowed = verdict.data?.allowed === true;
  const problem = verdict.isError
    ? "Couldn't check the session: the factory isn't reachable."
    : status
      ? fallbackLine(verdict.data, status, waitingSince ? now - waitingSince : 0)
      : verdict.data && !verdict.data.allowed
        ? fallbackLine(
            verdict.data,
            { phase: "connecting", mode: null, viewers: 0, message: null },
            0,
          )
        : null;
  const mode = status?.mode ?? verdict.data?.mode ?? null;
  useEffect(() => onMode?.(allowed ? mode : null), [allowed, mode, onMode]);

  return (
    <section
      aria-label="Terminal"
      className="flex h-full min-h-0 flex-col bg-panel"
      data-testid="terminal-panel"
    >
      <div
        className={cn(
          "flex h-10 flex-none items-center gap-2 border-line border-b px-3 text-[13px]",
          expanded && "pl-[84px]",
        )}
      >
        <SquareTerminalIcon className="size-3.5 text-ink-muted" />
        <span className="font-medium">Terminal</span>
        <span className="text-ink-muted">
          {stageLabel(run.stage)} · run {run.runNo}
        </span>
        {mode && (
          <span
            className={cn(
              "rounded-full px-[7px] py-px font-medium text-[11px]",
              mode === "type" ? "bg-chip-blue text-chip-blue-ink" : "bg-selected text-ink-muted",
            )}
            data-testid="terminal-mode"
          >
            {mode === "type" ? "You can type" : "Read-only"}
          </span>
        )}
        <span className="grow" />
        {onExpand && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onExpand}
            aria-label={expanded ? "Back to the page" : "Fill the window"}
            title={expanded ? "Back to the page" : "Fill the window"}
            data-testid="terminal-expand"
          >
            {expanded ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
            {expanded ? "Restore" : "Expand"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label={`Close the terminal (the session keeps running): Esc, or ${CLOSE_CHORD_LABEL} while typing`}
          title={`Close the terminal (the session keeps running): Esc, or ${CLOSE_CHORD_LABEL} while typing`}
          data-testid="terminal-close"
        >
          <XIcon className="size-3.5" />
          Close{" "}
          <Kbd className="bg-transparent" data-testid="terminal-close-chord">
            {mode === "type" ? CLOSE_CHORD_LABEL : "Esc"}
          </Kbd>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {verdict.isPending ? (
          <div className="p-2 text-ink-muted text-xs">Opening the terminal…</div>
        ) : allowed ? (
          <WebTerminal
            session={`${workItemId}/${run.id}`}
            connect={() => new RpcTerminalSocket(rpc, workItemId, run.id)}
            theme="system"
            autoFocus
            openLink={openExternal}
            className="min-h-0 flex-1"
            screenClassName="min-h-0 flex-1"
            onStatus={onStatus}
            footer={
              <>
                {problem && (
                  <span className="text-ink" data-testid="terminal-problem">
                    {problem}
                  </span>
                )}
                <AttachInstead takeover={run.takeover} />
              </>
            }
          />
        ) : (
          <div className="flex items-center gap-3 p-2 text-[13px]">
            <span data-testid="terminal-problem">{problem}</span>
            <span className="grow" />
            <AttachInstead takeover={run.takeover} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Where the dock sits when not expanded: over the lower part of the page area, or the window. */
export function dockHost(): HTMLElement | null {
  // A view that hosts its own terminal (the Work board's item panel) first, else the page.
  return (
    document.querySelector<HTMLElement>("[data-terminal-host]") ?? document.getElementById("main")
  );
}

function pageBox(): { left: number; right: number; top: number; bottom: number } {
  const main = dockHost();
  if (main) {
    const r = main.getBoundingClientRect();
    return { left: r.left, right: window.innerWidth - r.right, top: r.top, bottom: r.bottom };
  }
  // Planning focus has no page area: below the session bar, above the status bar.
  return { left: 0, right: 0, top: 44, bottom: window.innerHeight - 28 };
}

/**
 * The terminal in place: over the lower part of the item's page, resizable by its top edge, Expand
 * to fill the window. Esc closes it (the session keeps running), except while the keyboard is in a
 * terminal you can type into: there Esc belongs to the session (Claude Code's interrupt), and ⌘Esc
 * closes it (closesDock).
 */
export function TerminalDock({
  workItemId,
  run,
  onClose,
}: {
  workItemId: string;
  run: TerminalRun;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [box, setBox] = useState(pageBox);
  const [height, setHeight] = useState(() => Math.round((box.bottom - box.top) * 0.45));
  const dock = useRef<HTMLDivElement>(null);
  const typing = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The box it docks over is found again whenever the view moves (a tab switch renders another
  // page element; the side panel expands to the page), so it never measures one that is gone.
  const href = useRouterState({ select: (s) => s.location.href });
  useEffect(() => {
    void href;
    const update = () => setBox(pageBox());
    update();
    window.addEventListener("resize", update);
    const host = dockHost();
    const observer = host ? new ResizeObserver(update) : null;
    if (host) observer?.observe(host);
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [href]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as Element | null;
      const inTerminal = !!target?.closest(".xterm") && !!dock.current?.contains(target);
      const overlayOpen = !!document.querySelector(
        "[role=dialog], [data-radix-popper-content-wrapper]",
      );
      if (!closesDock(e, { inTypingTerminal: inTerminal && typing.current, overlayOpen })) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current();
    };
    // Capture: before the page's own Esc (planning focus leaves on Esc).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const setMode = useCallback((mode: "type" | "watch" | null) => {
    typing.current = mode === "type";
  }, []);

  const startDrag = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const max = box.bottom - box.top - 40;
    const move = (m: globalThis.PointerEvent) =>
      setHeight(Math.max(160, Math.min(max, startHeight + (startY - m.clientY))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const style = expanded
    ? { left: 0, right: 0, top: 0, bottom: 28 }
    : {
        left: box.left,
        right: box.right,
        top: Math.max(box.top + 40, box.bottom - height),
        bottom: window.innerHeight - box.bottom,
      };
  return createPortal(
    <div
      ref={dock}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden border-line bg-panel shadow-[0_-8px_30px_rgba(0,0,0,0.12)]",
        expanded ? "" : "border-t",
      )}
      style={style}
      data-testid="terminal-dock"
      data-expanded={expanded ? "true" : "false"}
    >
      {!expanded && (
        <button
          type="button"
          aria-label="Resize the terminal: drag its top edge"
          title="Drag to resize"
          className="h-1.5 w-full flex-none cursor-row-resize border-0 bg-transparent p-0 hover:bg-line"
          onPointerDown={startDrag}
          data-testid="terminal-resize"
        />
      )}
      <div className="min-h-0 flex-1">
        <TerminalPanel
          workItemId={workItemId}
          run={run}
          expanded={expanded}
          onExpand={() => setExpanded((x) => !x)}
          onClose={onClose}
          onMode={setMode}
        />
      </div>
    </div>,
    document.body,
  );
}
