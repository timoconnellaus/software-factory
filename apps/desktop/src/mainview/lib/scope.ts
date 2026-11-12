// The org rail's scope (ADR 0460): the reads already return every org's items, so the chosen org
// filters what is loaded. Null is All. Pure, so the tests drive it directly.
import type { Inbox, Project } from "@software-factory/client/ops";

type OrgOf = (projectId: string | null) => string | null;

export function orgOfProject(projects: Pick<Project, "id" | "orgId">[]): OrgOf {
  const map = new Map(projects.map((p) => [p.id, p.orgId]));
  return (projectId) => (projectId ? (map.get(projectId) ?? null) : null);
}

/**
 * The inbox as one org sees it. A gate with no project (a factory-wide approval) shows under every
 * org, since nothing ties it to one; runners belong to the person, so they aren't scoped.
 */
export function scopeInbox(inbox: Inbox, orgOf: OrgOf, orgId: string | null): Inbox {
  if (orgId === null) return inbox;
  const inOrg = (projectId: string | null) => !projectId || orgOf(projectId) === orgId;
  return {
    ...inbox,
    gates: inbox.gates.filter((g) => inOrg(g.projectId)),
    questions: inbox.questions.filter((q) => inOrg(q.projectId)),
    running: inbox.running.filter((r) => r.orgId === orgId),
    planning: inbox.planning.filter((p) => inOrg(p.projectId)),
    wipHolds: inbox.wipHolds.filter((h) => inOrg(h.projectId)),
    protection: inbox.protection.filter((p) => inOrg(p.projectId)),
  };
}

/** What waits on you: open gates and questions (the sidebar's count and the status bar's). */
export const waitingCount = (inbox: Pick<Inbox, "gates" | "questions">) =>
  inbox.gates.length + inbox.questions.length;

/** The orgs with something waiting on you (the rail's amber dots). */
export function orgsWaiting(inbox: Inbox, orgOf: OrgOf): Set<string> {
  const out = new Set<string>();
  for (const g of inbox.gates) {
    const o = orgOf(g.projectId);
    if (o) out.add(o);
  }
  for (const q of inbox.questions) {
    const o = orgOf(q.projectId);
    if (o) out.add(o);
  }
  return out;
}

/** An org's square: its initial. */
export const orgInitial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

/**
 * The org the window shows (null: All): the rail's choice, the Personal org before one is made, and
 * All for an org you've since left. Pages and their loaders both use it, so they agree.
 */
export function orgScope(
  session: { personalOrgId: string | null; orgs: { id: string }[] },
  chosen: string | null | undefined,
): string | null {
  if (chosen === undefined) return session.personalOrgId;
  if (chosen !== null && !session.orgs.some((o) => o.id === chosen)) return null;
  return chosen;
}
