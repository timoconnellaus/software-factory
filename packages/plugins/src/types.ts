// The plugin contract's shapes on the host's side: what the engine gives the host, the hooks, the
// payloads, a card, and the ways a dispatch can end.
import type { Item, ProjectRepo } from "@software-factory/store";
import { z } from "zod";

/** What the host needs from the engine's Env. */
export interface PluginHostEnv {
  DB: D1Database;
  /** The Worker Loader binding. Without it a plugin that has hooks fails when they run. */
  LOADER?: WorkerLoader;
  /** The engine secret gateway secrets are sealed with (docs/deploying.md). */
  FLOW_GATEWAY_KEY?: string;
  /**
   * The engine's GitHub App, for the built-in `github` gateway and the repository picker. Injected
   * by the engine (this package never imports it); without it neither is there.
   */
  github?: FlowGitHub;
}

/** A repository as the GitHub App reaches it: through one installation. */
export interface GitHubRepoRef {
  installationId: string;
  owner: string;
  name: string;
}

/** What the engine's GitHub App does for the new core. Every call goes to GitHub. */
export interface FlowGitHub {
  /** The repositories an installation reaches (paged by the App; at most a few hundred). */
  installationRepos(
    installationId: string,
  ): Promise<{ owner: string; name: string; defaultBranch: string }[]>;
  /**
   * A token for one repository with exactly these permissions. `cache: true` may hand back one
   * minted earlier that is far from expiring (the built-in gateway); a runner's token never is.
   */
  repoToken(
    repo: GitHubRepoRef,
    permissions: Record<string, string>,
    opts?: { cache?: boolean },
  ): Promise<{ token: string; expiresAt: string }>;
  /** The branch's head, or null when it doesn't exist. */
  branchSha(repo: GitHubRepoRef, branch: string): Promise<string | null>;
}

/** The built-in gateway's name, and what its token may do. */
export const GITHUB_GATEWAY = "github";
export const GITHUB_GATEWAY_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "read",
} as const;

export const HOOKS = ["entered", "leaving", "runEnded", "trigger"] as const;
export type HookName = (typeof HOOKS)[number];

/** The item as a plugin sees it: plain data. */
export interface PluginItem {
  id: string;
  number: number;
  title: string;
  body: string;
  statusId: string;
  fields: Record<string, unknown>;
  /** The item's branch on its project's repository, once a run there was claimed; else null. */
  branch: string | null;
  /** That branch's head as the last run that ended `done` pushed it; else null. */
  headSha: string | null;
  /** The item's project's repository, or null when it has none. */
  repo: { owner: string; name: string; defaultBranch: string } | null;
}

export function pluginItem(item: Item, repo: ProjectRepo | null = null): PluginItem {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    statusId: item.statusId,
    fields: item.fields,
    branch: item.branch,
    headSha: item.headSha,
    repo: repo ? { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch } : null,
  };
}

/** A run as `runEnded` sees it. A failed run's outcome is "failed" and its summary the error. */
export interface PluginRun {
  id: string;
  agentId: string;
  statusId: string;
  outcome: "done" | "rejected" | "failed";
  summary: string;
  /** The branch the run worked on, and the head it handed back; null without a repository. */
  branch: string | null;
  headSha: string | null;
}

export type HookPayload =
  | {
      hook: "entered" | "leaving";
      item: PluginItem;
      /** Status ids; `from` is null for a new item. */
      from: string | null;
      to: string;
      /** The statuses' names, as the workflow calls them. */
      fromName: string | null;
      toName: string;
    }
  | { hook: "runEnded"; item: PluginItem; run: PluginRun }
  | { hook: "trigger"; name: string; payload: unknown };

/** A rich timeline card, the one generic shape the app draws. */
export const cardSchema = z.object({
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  subtitle: z.string().max(1_000).optional(),
  rows: z
    .array(z.object({ label: z.string().max(200), value: z.string().max(2_000) }))
    .max(50)
    .optional(),
  checks: z
    .array(z.object({ label: z.string().max(200), ok: z.boolean() }))
    .max(50)
    .optional(),
  bars: z
    .array(z.object({ label: z.string().max(200), value: z.number(), max: z.number() }))
    .max(50)
    .optional(),
  link: z.object({ label: z.string().max(200), url: z.string().url() }).optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const fieldSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "number", "date"]),
});

/** What a module declares, read when it is saved. */
export const declarationSchema = z.object({
  fields: z.array(fieldSchema).max(50),
  hooks: z.array(z.enum(HOOKS)),
});
export type Declaration = z.infer<typeof declarationSchema>;

/** A plugin's `leaving` said no. For a person's or agent's move, the caller sees the reason. */
export class PluginRefusal extends Error {
  constructor(
    readonly plugin: string,
    readonly reason: string,
  ) {
    super(`Plugin "${plugin}" refused: ${reason}`);
    this.name = "PluginRefusal";
  }
}

/** How long one hook call into a plugin may take. */
export const HOOK_DEADLINE_MS = 10_000;

/** How many plugin moves (`ctx.move`) may follow one another before the item is stopped. */
export const MOVE_CHAIN_LIMIT = 10;
