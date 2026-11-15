// The new core's shell (.kim/mockups/board-and-item-panel.html, sidebar-c): the org strip, one
// sidebar that never changes (the org's sections, then its projects, then Old factory and Settings),
// and the content panel the pages fill. The window's toolbar (tabs, ⌘K) stays above it; the old
// shell's status bar does not show here.
import type { FlowProject } from "@software-factory/client/flow";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FactoryIcon,
  FolderIcon,
  InboxIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  PlusIcon,
  PuzzleIcon,
  SettingsIcon,
  SquareCheckIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  flowInboxQuery,
  flowProjectsQuery,
  flowWorkflowsQuery,
  useFlowRefresh,
} from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { orgInitial } from "../../lib/scope.ts";
import { useSession } from "../../lib/session.ts";
import { chooseOrg, updateViewState } from "../../lib/view-state.ts";
import { AccountMenu } from "../shell-sidebar.tsx";

/** The org the new shell shows: the path's, else the chosen one, else Personal, else the first. */
export function useFlowOrg(): string | null {
  const session = useSession();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const fromPath = /^\/flow\/([^/]+)/.exec(path)?.[1];
  if (fromPath && session.orgs.some((o) => o.id === fromPath)) return fromPath;
  return session.personalOrgId ?? session.orgs[0]?.id ?? null;
}

/** While the new shell shows, the window takes its look (desktop.css: `data-look="flow"`). */
function useFlowLook() {
  useEffect(() => {
    document.documentElement.dataset.look = "flow";
    return () => {
      delete document.documentElement.dataset.look;
    };
  }, []);
}

export function FlowShell() {
  useFlowLook();
  const orgId = useFlowOrg();
  return (
    <div className="flex min-h-0 flex-1 pr-2 pb-2" data-testid="flow-shell">
      <OrgStrip orgId={orgId} />
      {orgId && <FlowSidebar orgId={orgId} />}
      <div
        className="relative flex min-w-0 flex-1 select-text overflow-hidden rounded-xl border border-line bg-panel"
        data-testid="content-panel"
      >
        <Outlet />
      </div>
    </div>
  );
}

function OrgStrip({ orgId }: { orgId: string | null }) {
  const session = useSession();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const all = path === "/flow/orgs";
  return (
    <nav
      aria-label="Orgs"
      className="flex w-[52px] flex-none flex-col items-center gap-2 pt-1"
      data-testid="org-strip"
    >
      <Button
        asChild
        variant="ghost"
        size="icon-sm"
        className={cn("rounded-lg text-ink-muted", all && "bg-ink text-window hover:bg-ink")}
      >
        <Link to="/flow/orgs" aria-label="All orgs" title="All orgs" data-testid="all-orgs">
          <LayoutGridIcon />
        </Link>
      </Button>
      {session.orgs.map((o) => {
        const current = !all && o.id === orgId;
        return (
          <Button
            key={o.id}
            variant="ghost"
            size="icon-sm"
            title={o.name}
            aria-current={current ? "true" : undefined}
            onClick={() => {
              updateViewState((s) => chooseOrg(s, o.id));
              void navigate({ to: "/flow/$orgId/work", params: { orgId: o.id } });
            }}
            className={cn(
              "rounded-lg font-semibold text-[12px]",
              current
                ? "bg-ink text-window hover:bg-ink"
                : "bg-field text-ink hover:bg-line-strong",
            )}
            data-testid={`flow-org-${o.id}`}
          >
            {orgInitial(o.name)}
          </Button>
        );
      })}
      <span className="mt-auto" />
      <div className="pb-2.5">
        <AccountMenu />
      </div>
    </nav>
  );
}

type Section = "inbox" | "work" | "chat" | "team" | "auto" | "plugins" | "settings";

const SECTIONS: { id: Exclude<Section, "settings">; label: string; icon: React.ReactNode }[] = [
  { id: "inbox", label: "Inbox", icon: <InboxIcon /> },
  { id: "work", label: "Work", icon: <SquareCheckIcon /> },
  { id: "chat", label: "Chat", icon: <MessageSquareIcon /> },
  { id: "team", label: "Team", icon: <UsersIcon /> },
  { id: "auto", label: "Auto", icon: <ZapIcon /> },
  { id: "plugins", label: "Plugins", icon: <PuzzleIcon /> },
];

/** The section a path is in: a project's pages are Work's. */
export function flowSection(path: string): Section | null {
  const m = /^\/flow\/[^/]+\/([^/]+)/.exec(path);
  const part = m?.[1];
  if (!part) return null;
  if (part === "p") return "work";
  return (
    SECTIONS.some((s) => s.id === part) || part === "settings" ? part : null
  ) as Section | null;
}

const rowClass =
  "flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-ink hover:bg-hover [&>svg]:size-4 [&>svg]:flex-none [&>svg]:text-ink-muted";

function FlowSidebar({ orgId }: { orgId: string }) {
  const session = useSession();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const section = flowSection(path);
  const projectId = /^\/flow\/[^/]+\/p\/([^/]+)/.exec(path)?.[1] ?? null;
  const projects = useQuery(flowProjectsQuery(orgId));
  const inbox = useQuery(flowInboxQuery(orgId));
  const waiting = inbox.data ? inbox.data.work.length + inbox.data.decisions.length : 0;
  const orgName = session.orgs.find((o) => o.id === orgId)?.name ?? "";
  const [creating, setCreating] = useState(false);

  return (
    <nav
      aria-label={orgName}
      className="flex w-[224px] flex-none flex-col gap-px overflow-y-auto px-2 pt-1 pb-2.5"
      data-testid="flow-sidebar"
    >
      <div className="truncate px-2 pt-1 pb-3 font-semibold text-[14px]" data-testid="org-name">
        {orgName}
      </div>
      {SECTIONS.map((s) => {
        const on = section === s.id;
        return (
          <Link
            key={s.id}
            to={`/flow/$orgId/${s.id}`}
            params={{ orgId }}
            aria-current={on ? "page" : undefined}
            className={cn(
              rowClass,
              on && "bg-panel font-medium shadow-[0_0_0_1px_var(--line)] hover:bg-panel",
            )}
            data-testid={`flow-nav-${s.id}`}
          >
            {s.icon}
            {s.label}
            {s.id === "inbox" && waiting > 0 && (
              <span
                className="ml-auto rounded-lg bg-need-soft px-1.5 font-semibold text-[11.5px] text-need"
                data-testid="flow-inbox-count"
              >
                {waiting}
              </span>
            )}
          </Link>
        );
      })}
      <div className="mx-2 mt-3.5 mb-0.5 flex items-center justify-between font-medium text-[11px] text-ink-faint">
        Projects
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New project"
          title="New project"
          className="-mr-1 size-5 text-ink-faint hover:text-ink"
          onClick={() => setCreating(true)}
          data-testid="new-project"
        >
          <PlusIcon />
        </Button>
      </div>
      {(projects.data?.projects ?? []).map((p) => (
        <ProjectLink key={p.id} orgId={orgId} project={p} current={p.id === projectId} />
      ))}
      <span className="mt-auto" />
      <Link to="/" className={rowClass} data-testid="flow-nav-old-factory">
        <FactoryIcon />
        Old factory
      </Link>
      <Link
        to="/flow/$orgId/settings"
        params={{ orgId }}
        aria-current={section === "settings" ? "page" : undefined}
        className={cn(
          rowClass,
          section === "settings" && "bg-panel font-medium shadow-[0_0_0_1px_var(--line)]",
        )}
        data-testid="flow-nav-settings"
      >
        <SettingsIcon />
        Settings
      </Link>
      <NewProjectDialog orgId={orgId} open={creating} onOpenChange={setCreating} />
    </nav>
  );
}

function ProjectLink({
  orgId,
  project,
  current,
}: {
  orgId: string;
  project: FlowProject;
  current: boolean;
}) {
  const count = project.nextNumber - 1;
  return (
    <Link
      to="/flow/$orgId/p/$projectId"
      params={{ orgId, projectId: project.id }}
      aria-current={current ? "page" : undefined}
      className={cn(rowClass, current && "bg-picked hover:bg-picked")}
      data-testid="flow-project"
    >
      <FolderIcon />
      <span className="truncate">{project.name}</span>
      {count > 0 && <span className="ml-auto text-[11.5px] text-ink-faint">{count}</span>}
    </Link>
  );
}

/** "Field Planner" → "FP". */
export function keyFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  return key
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 10);
}

function NewProjectDialog({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const refresh = useFlowRefresh(orgId);
  const workflows = useQuery({ ...flowWorkflowsQuery(orgId), enabled: open });
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const list = workflows.data?.workflows ?? [];
  const chosen = workflowId ?? list[0]?.id ?? null;
  const shownKey = key ?? keyFor(name);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen || !name.trim() || !shownKey) return;
    setSaving(true);
    setError(null);
    try {
      const project = await op(
        "flow.project.create",
        { orgId, name: name.trim(), key: shownKey, workflowId: chosen },
        { idempotencyKey: submitKey() },
      );
      await refresh();
      onOpenChange(false);
      setName("");
      setKey(null);
      void navigate({ to: "/flow/$orgId/p/$projectId", params: { orgId, projectId: project.id } });
    } catch (err) {
      setError(err instanceof OpError || err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="project-key">Key</Label>
            <Input
              id="project-key"
              value={shownKey}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              maxLength={10}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Workflow</Label>
            {workflows.isSuccess && list.length === 0 ? (
              <p className="text-ink-muted">This org has no workflows yet.</p>
            ) : (
              <Select value={chosen ?? undefined} onValueChange={setWorkflowId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a workflow" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.workflow.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {error && <p className="text-bad">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving || !chosen || !name.trim() || !shownKey}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
