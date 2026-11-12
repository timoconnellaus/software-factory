// The org rail (52px) and the sidebar (196px), spec 41. The rail chooses the org (or All) the rest of
// the window shows; the sidebar has the org's sections, its pinned work items and Settings.
import { Avatar, AvatarFallback } from "@software-factory/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@software-factory/ui/components/dropdown-menu";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  FactoryIcon,
  InboxIcon,
  LayoutGridIcon,
  LogOutIcon,
  SlidersHorizontalIcon,
  SquareCheckIcon,
} from "lucide-react";
import { bun } from "../bridge.ts";
import { sectionOf } from "../lib/places.ts";
import { inboxQuery, projectsQuery, workListsQuery } from "../lib/queries.ts";
import { orgInitial, orgOfProject, orgsWaiting, scopeInbox, waitingCount } from "../lib/scope.ts";
import { useSession } from "../lib/session.ts";
import { chooseOrg, updateViewState, useViewState } from "../lib/view-state.ts";

/** The chosen org (null: All), defaulting to the Personal org the first time. */
export function useOrgScope(): string | null {
  const session = useSession();
  const chosen = useViewState((s) => s.orgId);
  if (chosen === undefined) return session.personalOrgId;
  // An org you've since left: show All rather than nothing.
  if (chosen !== null && !session.orgs.some((o) => o.id === chosen)) return null;
  return chosen;
}

/** The inbox as the chosen org sees it, and the org-of-project lookup. */
export function useScopedInbox() {
  const session = useSession();
  const orgId = useOrgScope();
  const inbox = useQuery(inboxQuery());
  const projects = useQuery(projectsQuery(session.orgs.map((o) => o.id)));
  const orgOf = orgOfProject(projects.data ?? []);
  return {
    orgId,
    orgOf,
    query: inbox,
    inbox: inbox.data ? scopeInbox(inbox.data, orgOf, orgId) : undefined,
  };
}

export function OrgRail() {
  const session = useSession();
  const orgId = useOrgScope();
  const { query, orgOf } = useScopedInbox();
  const waiting = query.data ? orgsWaiting(query.data, orgOf) : new Set<string>();
  return (
    <nav
      aria-label="Orgs"
      className="flex w-[52px] flex-none flex-col items-center gap-2 pt-1 pb-2.5"
      data-testid="org-rail"
    >
      <button
        type="button"
        aria-label="All orgs"
        aria-current={orgId === null ? "true" : undefined}
        title="All orgs"
        onClick={() => updateViewState((s) => chooseOrg(s, null))}
        className={cn(
          "flex size-8 items-center justify-center rounded-[9px] text-ink-3 hover:bg-field",
          orgId === null && "bg-panel text-ink shadow-panel",
        )}
      >
        <LayoutGridIcon className="size-4" />
      </button>
      <span aria-hidden className="h-px w-5 bg-line-strong" />
      {session.orgs.map((o) => {
        const current = o.id === orgId;
        return (
          <button
            key={o.id}
            type="button"
            title={o.name}
            aria-label={`${o.name}${waiting.has(o.id) ? ", something waits on you" : ""}`}
            aria-current={current ? "true" : undefined}
            onClick={() => updateViewState((s) => chooseOrg(s, o.id))}
            className={cn(
              "relative flex size-8 items-center justify-center rounded-[9px] font-semibold",
              current
                ? "bg-ink text-window shadow-[0_0_0_2px_var(--window),0_0_0_3.5px_var(--ink)]"
                : "bg-line-strong text-ink hover:brightness-95",
            )}
            data-testid={`org-${o.id}`}
          >
            {orgInitial(o.name)}
            {waiting.has(o.id) && (
              <span
                aria-hidden
                className="-top-1 -right-1 absolute size-[9px] rounded-full border-2 border-window bg-status-waiting"
                data-testid="org-waiting"
              />
            )}
          </button>
        );
      })}
      <span className="mt-auto" />
      <AccountMenu />
    </nav>
  );
}

function AccountMenu() {
  const session = useSession();
  const client = useQueryClient();
  const name = session.user.githubLogin ?? "you";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Your account"
          className="flex size-7 items-center justify-center rounded-full"
          data-testid="user-menu"
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-line-strong text-[11px] text-ink-3">
              {name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="font-medium">@{name}</div>
          <div className="text-muted-foreground text-xs">Signed in on this Mac</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => client.setQueryData(["session"], await bun.signOut({}))}
          data-testid="sign-out"
        >
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar() {
  const session = useSession();
  const orgId = useOrgScope();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionOf(path);
  const { inbox } = useScopedInbox();
  const waiting = inbox ? waitingCount(inbox) : 0;
  const pins = useViewState((s) => s.pins);
  const items = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const pinned = pins
    .map((id) => items.data?.find((i) => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i && (orgId === null || i.orgId === orgId));
  const orgName =
    orgId === null ? "All orgs" : (session.orgs.find((o) => o.id === orgId)?.name ?? "");

  return (
    <nav
      aria-label={orgName}
      className="flex w-[196px] flex-none flex-col gap-px pt-0.5 pr-2 pb-2.5 pl-1"
      data-testid="sidebar"
    >
      <div className="flex h-8 items-center px-2 font-semibold text-sm" data-testid="org-name">
        <span className="truncate">{orgName}</span>
      </div>
      <SideLink to="/" active={section === "inbox"} icon={<InboxIcon />}>
        Inbox
        {waiting > 0 && (
          <span
            className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-chip-amber px-[5px] font-semibold text-[11px] text-chip-amber-ink"
            data-testid="inbox-count"
          >
            {waiting}
          </span>
        )}
      </SideLink>
      <SideLink to="/work" active={section === "work"} icon={<SquareCheckIcon />}>
        Work
      </SideLink>
      <SideLink to="/factory" active={section === "factory"} icon={<FactoryIcon />}>
        Factory
      </SideLink>
      {pinned.length > 0 && (
        <>
          <div className="px-2 pt-4 pb-1 font-medium text-[11px] text-ink-muted">Pinned</div>
          {pinned.map((i) => (
            <Link
              key={i.id}
              to="/work/$id"
              params={{ id: i.id }}
              className={cn(
                "flex h-7 items-center gap-[9px] rounded-[7px] px-2 text-ink-2 hover:bg-field/60",
                path === `/work/${i.id}` && "bg-panel text-ink shadow-panel",
              )}
              data-testid="pinned"
            >
              <span className="mx-[4.5px] flex">
                <span
                  className={cn(
                    "size-[7px] rounded-full",
                    i.status === "running"
                      ? "bg-status-running"
                      : i.status === "waiting"
                        ? "bg-status-waiting"
                        : i.status === "done"
                          ? "bg-status-done"
                          : "bg-status-idle",
                  )}
                />
              </span>
              <span className="truncate">
                #{i.number} {i.title}
              </span>
            </Link>
          ))}
        </>
      )}
      <span className="mt-auto" />
      <SideLink to="/settings" active={section === "settings"} icon={<SlidersHorizontalIcon />}>
        Settings
      </SideLink>
    </nav>
  );
}

function SideLink({
  to,
  active,
  icon,
  children,
}: {
  to: "/" | "/work" | "/factory" | "/settings";
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-[30px] items-center gap-[9px] rounded-[7px] px-2 text-ink-2 hover:bg-field/60 [&>svg]:size-4 [&>svg]:text-ink-3",
        active && "bg-panel font-medium text-ink shadow-panel hover:bg-panel",
      )}
      data-testid={`nav-${to === "/" ? "inbox" : to.slice(1)}`}
    >
      {icon}
      {children}
    </Link>
  );
}
