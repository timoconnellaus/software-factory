// The toolbar (spec 41): under the traffic lights, the window's drag region. Back and forward, the
// sidebar toggle, the tabs, search (⌘K) and New item. Its controls opt out of dragging.
import { Kbd } from "@software-factory/ui/components/kbd";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect } from "react";
import { type ItemRef, tabTitle } from "../lib/places.ts";
import { workListsQuery } from "../lib/queries.ts";
import { useSession } from "../lib/session.ts";
import { shortcutLabel } from "../lib/shortcuts.ts";
import { DRAG, NO_DRAG } from "../lib/title-bar.ts";
import {
  activateTab,
  closeTab,
  followNavigation,
  openTab,
  toggleSidebar,
  updateViewState,
  useViewState,
} from "../lib/view-state.ts";

/** The drag region's classes (Electrobun's preload turns them into window drags). */
export { DRAG, NO_DRAG };

/** Looks a work item up in what the app has loaded: the shell's lists, then the item's own read. */
export function useItemLookup(): (id: string) => ItemRef | null {
  const session = useSession();
  const client = useQueryClient();
  const lists = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  return (id) => {
    const fromList = lists.data?.find((i) => i.id === id);
    if (fromList) return fromList;
    const detail = client.getQueryData<{ item: ItemRef }>(["workItem", id]);
    return detail?.item ?? null;
  };
}

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
  const tabs = useViewState((s) => s.tabs);
  const activeTab = useViewState((s) => s.activeTab);
  const sidebar = useViewState((s) => s.sidebar);
  const lookup = useItemLookup();
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
      <ToolButton
        label={`${sidebar ? "Hide" : "Show"} the sidebar (${shortcutLabel("sidebar")})`}
        onClick={() => updateViewState(toggleSidebar)}
      >
        <PanelLeftIcon />
      </ToolButton>
      <span className="w-2 flex-none" />
      <div className="flex min-w-0 items-center gap-1 overflow-hidden" role="tablist">
        {tabs.map((t) => {
          const active = t.id === activeTab;
          const ref = itemOfPath(t.path, lookup);
          const dot =
            ref?.status === "running"
              ? "bg-status-running"
              : ref?.status === "waiting"
                ? "bg-status-waiting"
                : null;
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
                "group flex h-[30px] min-w-0 max-w-[240px] flex-none cursor-default items-center gap-2 rounded-lg px-2.5 text-ink-3",
                active ? "bg-panel font-medium text-ink shadow-panel" : "hover:bg-field/60",
              )}
              data-testid="tab"
            >
              {dot && <span className={cn("size-[7px] flex-none rounded-full", dot)} />}
              <span className="truncate">{tabTitle(t.path, lookup)}</span>
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
      <Link
        to="/new"
        className={cn(
          NO_DRAG,
          "ml-1.5 flex h-7 flex-none items-center gap-1.5 rounded-[7px] bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/90",
        )}
        data-testid="nav-new-work"
      >
        <PlusIcon className="size-3" strokeWidth={2.2} />
        New item
      </Link>
    </div>
  );
}

function itemOfPath(path: string, lookup: (id: string) => ItemRef | null): ItemRef | null {
  const m = /^\/work\/([^/?]+)/.exec(path);
  return m?.[1] ? lookup(decodeURIComponent(m[1])) : null;
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
        "flex size-7 flex-none items-center justify-center rounded-md text-ink-3 hover:bg-field [&_svg]:size-4",
      )}
    >
      {children}
    </button>
  );
}
