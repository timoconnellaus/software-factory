// The sidebar (ported from sf-app, spec 40 M3): + New work, Inbox, Work, Setup, This Mac, the
// projects (their settings stay on the website for now) and the runner health line.
import { Avatar, AvatarFallback } from "@software-factory/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@software-factory/ui/components/dropdown-menu";
import { Kbd } from "@software-factory/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@software-factory/ui/components/sidebar";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { InboxIcon, LaptopIcon, ListIcon, LogOutIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect } from "react";
import { bun } from "../bridge.ts";
import { ExternalLink, WEBSITE_URL } from "../lib/external.tsx";
import { inboxQuery, projectsQuery } from "../lib/queries.ts";
import { RunnerHealth } from "./runner-health.tsx";

const appRoute = getRouteApi("/_app");

export function AppSidebar() {
  const { session } = appRoute.useRouteContext();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const inbox = useQuery(inboxQuery());
  const projects = useQuery(projectsQuery(session.orgs.map((o) => o.id)));
  const waiting = (inbox.data?.gates.length ?? 0) + (inbox.data?.questions.length ?? 0);
  const navigate = useNavigate();
  const personal = session.orgs.find((o) => o.id === session.personalOrgId);

  // N opens New work from anywhere outside a text field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable=true]")) return;
      if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void navigate({ to: "/new" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-1 pb-2">
          <div className="grid size-7 place-items-center rounded-md bg-primary font-semibold text-primary-foreground text-xs">
            SF
          </div>
          <div className="grid min-w-0 leading-tight">
            <span className="truncate font-semibold text-sm">{personal?.name ?? "Personal"}</span>
            <span className="truncate text-muted-foreground text-xs">
              {session.user.githubLogin ? `@${session.user.githubLogin}` : "signed in"}
            </span>
          </div>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={path === "/new"} className="border bg-background">
              <Link to="/new" data-testid="nav-new-work">
                <PlusIcon />
                <span>New work</span>
                <Kbd className="ml-auto">N</Kbd>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/"}>
                <Link to="/">
                  <InboxIcon />
                  <span>Inbox</span>
                </Link>
              </SidebarMenuButton>
              {waiting > 0 && (
                <SidebarMenuBadge data-testid="inbox-count">{waiting}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path.startsWith("/work")}>
                <Link to="/work">
                  <ListIcon />
                  <span>Work</span>
                </Link>
              </SidebarMenuButton>
              {inbox.data && inbox.data.running.length > 0 && (
                <SidebarMenuBadge>{inbox.data.running.length}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/setup"}>
                <Link to="/setup">
                  <SettingsIcon />
                  <span>Setup</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={path === "/settings"}>
                <Link to="/settings" data-testid="nav-this-mac">
                  <LaptopIcon />
                  <span>This Mac</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarMenu>
            {(projects.data ?? []).map((p) => (
              <SidebarMenuItem key={p.id}>
                <SidebarMenuButton asChild>
                  <Link to="/work" search={{ project: p.id }}>
                    <StatusDot status={p.policySha ? "done" : "idle"} className="mx-1" />
                    <span className="truncate">{p.name}</span>
                  </Link>
                </SidebarMenuButton>
                <SidebarMenuAction asChild showOnHover>
                  {/* Project settings (spec 09) aren't in the desktop yet: they open on the website. */}
                  <ExternalLink
                    href={`${WEBSITE_URL}/projects/${p.id}/settings`}
                    title={`${p.name} settings (website)`}
                    data-testid={`project-settings-${p.slug}`}
                  >
                    <SettingsIcon />
                  </ExternalLink>
                </SidebarMenuAction>
              </SidebarMenuItem>
            ))}
            {projects.data?.length === 0 && (
              <p className="px-2 text-muted-foreground text-xs">
                No projects yet.{" "}
                <Link to="/setup" className="underline">
                  Add one
                </Link>
              </p>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <RunnerHealth runners={inbox.data?.runners} compact />
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

function UserMenu() {
  const { session } = appRoute.useRouteContext();
  const client = useQueryClient();
  const name = session.user.githubLogin ?? "you";
  async function signOut() {
    client.setQueryData(["session"], await bun.signOut({}));
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-sidebar-accent"
          data-testid="user-menu"
        >
          <Avatar className="size-6">
            <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="font-medium">@{name}</div>
          <div className="text-muted-foreground text-xs">Signed in on this Mac</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} data-testid="sign-out">
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
