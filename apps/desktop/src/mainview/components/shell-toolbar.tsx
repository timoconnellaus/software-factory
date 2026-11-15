// The toolbar (spec 41): under the traffic lights, the window's drag region. Back and forward, the
// tabs and search (⌘K). Its controls opt out of dragging. Every control in it is 28px high with the
// same 7px radius (spec 41, criterion 14).
import type { FlowProject } from "@software-factory/client/flow";
import { Kbd } from "@software-factory/ui/components/kbd";
import { cn } from "@software-factory/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import { tabTitle } from "../lib/places.ts";
import { shortcutLabel } from "../lib/shortcuts.ts";
import { DRAG, NO_DRAG } from "../lib/title-bar.ts";
import {
  activateTab,
  closeTab,
  followNavigation,
  openTab,
  updateViewState,
  useViewState,
} from "../lib/view-state.ts";

/** The drag region's classes (Electrobun's preload turns them into window drags). */
export { DRAG, NO_DRAG };

/** Keeps the active tab on the router's location, and returns the tab helpers. */
export function useTabs() {
  const router = useRouter();
  const href = useRouterState({ select: (s) => s.location.href });
  useEffect(() => {
    updateViewState((s) => followNavigation(s, href));
  }, [href]);
  const go = (path: string | null) => {
    if (path) router.history.push(path);
  };
  return {
    newTab: (path = "/") => {
      updateViewState((s) => openTab(s, path));
      go(path);
    },
    close: (id: string) => {
      let to: string | null = null;
      updateViewState((s) => {
        const r = closeTab(s, id);
        to = r.navigate;
        return r.state;
      });
      go(to);
    },
    activate: (id: string) => {
      let to: string | null = null;
      updateViewState((s) => {
        const r = activateTab(s, id);
        to = r.navigate;
        return r.state;
      });
      go(to);
    },
  };
}

export function Toolbar({ onSearch }: { onSearch: () => void }) {
  const router = useRouter();
  const client = useQueryClient();
  const tabs = useViewState((s) => s.tabs);
  const activeTab = useViewState((s) => s.activeTab);
  // A project's tab is its name once a sidebar has loaded it (any org's `flow.project.list`).
  const projectName = (id: string) => {
    for (const [, data] of client.getQueriesData<{ projects: FlowProject[] }>({
      predicate: (q) => q.queryKey[0] === "flow" && q.queryKey[2] === "projects",
    })) {
      const found = data?.projects.find((p) => p.id === id);
      if (found) return found.name;
    }
    return null;
  };
  const { newTab, close, activate } = useTabs();
  const canBack = useRouterState({ select: (s) => (s.location.state.__TSR_index ?? 0) > 0 });

  return (
    <div
      role="toolbar"
      aria-label="Window"
      className={cn(DRAG, "flex h-11 flex-none items-center gap-1 pr-2.5 pl-[84px]")}
      data-testid="toolbar"
    >
      <ToolButton label={`Back (${shortcutLabel("back")})`} onClick={() => router.history.back()}>
        <ChevronLeftIcon className={cn(!canBack && "text-ink-faint")} />
      </ToolButton>
      <ToolButton
        label={`Forward (${shortcutLabel("forward")})`}
        onClick={() => router.history.forward()}
      >
        <ChevronRightIcon />
      </ToolButton>
      <span className="w-2 flex-none" />
      <div className="flex min-w-0 items-center gap-1 overflow-hidden" role="tablist">
        {tabs.map((t) => {
          const active = t.id === activeTab;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => activate(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") activate(t.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) close(t.id);
              }}
              className={cn(
                NO_DRAG,
                "group flex h-7 min-w-0 max-w-[240px] flex-none cursor-default items-center gap-2 rounded-[7px] px-2.5 text-ink-3",
                active ? "bg-panel font-medium text-ink shadow-panel" : "hover:bg-field/60",
              )}
              data-testid="tab"
            >
              <span className="truncate">{tabTitle(t.path, projectName)}</span>
              {(active || tabs.length > 1) && (
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                  className={cn(
                    "-mr-1 ml-1 flex size-4 flex-none items-center justify-center rounded text-ink-faint hover:bg-field hover:text-ink-3",
                    !active && "invisible group-hover:visible",
                  )}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <ToolButton label={`New tab (${shortcutLabel("new-tab")})`} onClick={() => newTab()}>
        <PlusIcon />
      </ToolButton>
      <span className="min-w-4 flex-1" />
      <button
        type="button"
        onClick={onSearch}
        className={cn(
          NO_DRAG,
          "flex h-7 w-[260px] flex-none items-center gap-2 rounded-[7px] bg-field pr-2 pl-2.5 text-ink-muted",
        )}
        data-testid="search"
      >
        <SearchIcon className="size-3.5" />
        Search or go to
        <Kbd className="ml-auto bg-transparent font-mono text-[11px] text-ink-muted">⌘K</Kbd>
      </button>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        NO_DRAG,
        "flex size-7 flex-none items-center justify-center rounded-[7px] text-ink-3 hover:bg-field [&_svg]:size-4",
      )}
    >
      {children}
    </button>
  );
}
