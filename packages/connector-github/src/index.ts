// The GitHub App connector (ADR 0010, 0025, 0037, 0052): turns one App webhook into the factory
// operations it implies. It never writes and never calls GitHub; sf-engine mounts it at
// /webhooks/github, authenticates the delivery (`@software-factory/connector-webhook`) and invokes
// the calls it returns as `{ type: "intake", id: "github" }`.
//
//   pull_request opened/reopened/synchronize/ready_for_review → verify.refresh (a new head starts
//                                                     without a passing `factory/verify`; a push
//                                                     to an attached PR re-verifies, spec 05)
//   pull_request closed                               → verify.refresh `closed` (an attached PR
//                                                     closed without merging cancels its item)
//   check_suite completed (not the factory's own)     → verify.refresh (CI settled on a SHA)
//   check_run rerequested (`factory/verify`)          → verify.refresh
//   push                                              → push.observe (branch confinement; policy
//                                                     mirror on the default branch)
//   installation / installation_repositories          → github.installation (record status,
//                                                     repos added/removed, suspend, delete)
//   repository_ruleset / branch_protection_rule       → protection.observe (re-check the default
//                                                     branch's protection: drift, ADR 0280)
import { z } from "zod";

export const PACKAGE = "@software-factory/connector-github";
export const VERIFY_CHECK = "factory/verify";
/** The actor every connector call runs as. */
export const GITHUB_INTAKE = { type: "intake", id: "github" } as const;

export interface OperationCall {
  op: "verify.refresh" | "push.observe" | "github.installation" | "protection.observe";
  input: Record<string, unknown>;
}

export interface Routed {
  /** `owner/name` of the repo the event is about, when there is one. */
  repo: string | null;
  action: string | null;
  calls: OperationCall[];
  /** Why nothing is done, when `calls` is empty. */
  ignored: string | null;
}

const repository = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  full_name: z.string().optional(),
});
const app = z.object({ slug: z.string() }).nullable().optional();

const pullRequest = z.object({
  action: z.string(),
  repository,
  pull_request: z.object({
    number: z.number(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    head: z.object({ sha: z.string(), ref: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
});

const checkSuite = z.object({
  action: z.string(),
  repository,
  check_suite: z.object({ head_sha: z.string(), status: z.string().nullable(), app }),
});

const checkRun = z.object({
  action: z.string(),
  repository,
  check_run: z.object({ name: z.string(), head_sha: z.string(), app }),
});

const push = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository,
  pusher: z.object({ name: z.string() }).optional(),
  sender: z.object({ login: z.string(), type: z.string().optional() }).optional(),
});

const repoEntry = z.object({ name: z.string(), id: z.number().optional() });
const installation = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string(), type: z.string().optional() }),
    repository_selection: z.enum(["all", "selected"]).optional(),
  }),
  repository_selection: z.enum(["all", "selected"]).optional(),
  repositories: z.array(repoEntry).optional(),
  repositories_added: z.array(repoEntry).optional(),
  repositories_removed: z.array(repoEntry).optional(),
});

const protectionChange = z.object({
  action: z.string(),
  // Org-level rulesets arrive without a repository: nothing to re-check here (the daily check
  // covers them).
  repository: repository.optional(),
});

const PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * Maps one delivery to operation calls. `appSlug` is the factory's App: its own check suites and
 * check runs are ignored (so posting `factory/verify` doesn't loop), and pushes by `<slug>[bot]`
 * are the App's (ADR 0052).
 */
export function routeGitHubEvent(event: string, payload: unknown, appSlug: string): Routed {
  const none = (repo: string | null, action: string | null, ignored: string): Routed => ({
    repo,
    action,
    calls: [],
    ignored,
  });
  const repoOf = (r: z.infer<typeof repository>) => ({ owner: r.owner.login, name: r.name });
  const full = (r: z.infer<typeof repository>) => `${r.owner.login}/${r.name}`;

  switch (event) {
    case "ping":
      return none(null, null, "ping");
    case "pull_request": {
      const p = pullRequest.safeParse(payload);
      if (!p.success) return none(null, null, "unreadable pull_request payload");
      const { action, pull_request: pr, repository: r } = p.data;
      if (action === "closed") {
        return {
          repo: full(r),
          action,
          ignored: null,
          calls: [
            {
              op: "verify.refresh",
              input: {
                repo: repoOf(r),
                headSha: pr.head.sha,
                prNumber: pr.number,
                trigger: "closed",
                merged: pr.merged === true,
              },
            },
          ],
        };
      }
      if (!PR_ACTIONS.has(action)) return none(full(r), action, `pull_request ${action}`);
      return {
        repo: full(r),
        action,
        ignored: null,
        calls: [
          {
            op: "verify.refresh",
            input: {
              repo: repoOf(r),
              headSha: pr.head.sha,
              prNumber: pr.number,
              trigger: "pull_request",
            },
          },
        ],
      };
    }
    case "check_suite": {
      const p = checkSuite.safeParse(payload);
      if (!p.success) return none(null, null, "unreadable check_suite payload");
      const { action, check_suite: cs, repository: r } = p.data;
      if (action !== "completed") return none(full(r), action, `check_suite ${action}`);
      if (cs.app?.slug === appSlug) return none(full(r), action, "the factory's own check suite");
      return {
        repo: full(r),
        action,
        ignored: null,
        calls: [
          { op: "verify.refresh", input: { repo: repoOf(r), headSha: cs.head_sha, trigger: "ci" } },
        ],
      };
    }
    case "check_run": {
      const p = checkRun.safeParse(payload);
      if (!p.success) return none(null, null, "unreadable check_run payload");
      const { action, check_run: cr, repository: r } = p.data;
      // Only a person asking to re-run `factory/verify`; CI is covered by check_suite.
      if (action === "rerequested" && cr.name === VERIFY_CHECK && cr.app?.slug === appSlug) {
        return {
          repo: full(r),
          action,
          ignored: null,
          calls: [
            {
              op: "verify.refresh",
              input: { repo: repoOf(r), headSha: cr.head_sha, trigger: "rerequested" },
            },
          ],
        };
      }
      return none(full(r), action, `check_run ${action} (${cr.name})`);
    }
    case "push": {
      const p = push.safeParse(payload);
      if (!p.success) return none(null, null, "unreadable push payload");
      const d = p.data;
      const pusher = d.sender?.login ?? d.pusher?.name ?? "unknown";
      return {
        repo: full(d.repository),
        action: null,
        ignored: null,
        calls: [
          {
            op: "push.observe",
            input: {
              repo: repoOf(d.repository),
              ref: d.ref,
              before: d.before,
              after: d.after,
              pusher,
              pusherIsApp: pusher === `${appSlug}[bot]`,
            },
          },
        ],
      };
    }
    case "installation":
    case "installation_repositories": {
      const p = installation.safeParse(payload);
      if (!p.success) return none(null, null, `unreadable ${event} payload`);
      const d = p.data;
      const type = d.installation.account.type;
      const selection = d.repository_selection ?? d.installation.repository_selection;
      const base = {
        installationId: String(d.installation.id),
        account: d.installation.account.login,
        ...(type === "User" || type === "Organization" ? { accountType: type } : {}),
        ...(selection ? { repositorySelection: selection } : {}),
      };
      const repos = (list?: z.infer<typeof repoEntry>[]) =>
        list
          ? {
              repositories: list.map((x) => x.name),
              ...(list.every((x) => x.id !== undefined)
                ? { repositoryIds: list.map((x) => x.id as number) }
                : {}),
            }
          : { repositories: null };
      const one = (action: string, extra: Record<string, unknown> = { repositories: null }) => ({
        op: "github.installation" as const,
        input: { ...base, action, ...extra },
      });
      let calls: OperationCall[] = [];
      if (event === "installation") {
        if (d.action === "created" || d.action === "new_permissions_accepted") {
          calls = [one("added", repos(d.repositories))];
        } else if (d.action === "unsuspend") {
          calls = [one("unsuspended")];
        } else if (d.action === "suspend") {
          calls = [one("suspended")];
        } else if (d.action === "deleted") {
          calls = [one("deleted")];
        }
      } else {
        if (d.repositories_added?.length) calls.push(one("added", repos(d.repositories_added)));
        if (d.repositories_removed?.length) {
          calls.push(one("removed", repos(d.repositories_removed)));
        }
        // A change of selection alone (e.g. "all" ↔ "selected") still updates the record.
        if (!calls.length && selection) calls.push(one("added", { repositories: [] }));
      }
      return {
        repo: null,
        action: d.action,
        calls,
        ignored: calls.length ? null : `${event} ${d.action}`,
      };
    }
    case "repository_ruleset":
    case "branch_protection_rule": {
      const p = protectionChange.safeParse(payload);
      if (!p.success) return none(null, null, `unreadable ${event} payload`);
      const { action, repository: r } = p.data;
      if (!r) return none(null, action, `${event} ${action} without a repository`);
      return {
        repo: full(r),
        action,
        ignored: null,
        calls: [{ op: "protection.observe", input: { repo: repoOf(r), event, action } }],
      };
    }
    default:
      return none(null, null, `event ${event} isn't used`);
  }
}

/**
 * The events the App must subscribe to, and the permissions it needs, for this connector and
 * `factory/verify` (docs/deploying.md).
 */
export const APP_REQUIREMENTS = {
  events: [
    "pull_request",
    "check_suite",
    "check_run",
    "push",
    "installation",
    "installation_repositories",
    // Drift detection on the default branch's protection (ADR 0280). Read-only: the factory never
    // changes protection.
    "repository_ruleset",
    "branch_protection_rule",
  ],
  /** `administration` stays `read`: write would let the App delete repositories (ADR 0280). */
  permissions: {
    contents: "write",
    pull_requests: "write",
    checks: "write",
    administration: "read",
    metadata: "read",
  },
} as const;
