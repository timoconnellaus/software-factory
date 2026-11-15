// The org's GitHub connection (ADR 0055): connect a GitHub App installation by GitHub's own install
// flow, and keep its record current from the App's installation webhooks. Nobody types or sees an
// installation id. The new core reads `core_github_installations` for a project's repository, its
// runs' tokens and the built-in `github` gateway (spec 70).
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { isOrgAdmin } from "../scope.ts";
import type { InstallationInfo } from "../services.ts";
import { randomToken, sha256Hex } from "../tokens.ts";

/** How long a "Connect GitHub" round trip may take. */
export const CONNECT_STATE_TTL_MS = 15 * 60_000;

type InstallationRecord = {
  id: string;
  org_id: string;
  installation_id: string;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  status: "active" | "suspended" | "deleted";
};

const installationView = z.object({
  id: z.string(),
  account: z.string(),
  accountType: z.enum(["User", "Organization"]),
  repositorySelection: z.enum(["all", "selected"]),
  status: z.enum(["active", "suspended", "deleted"]),
  /** GitHub's page for choosing which repositories the App can reach. */
  manageUrl: z.string(),
});

/** GitHub's page for an installation's settings (which repositories it reaches). */
export function manageInstallationUrl(record: {
  installation_id: string;
  account_login: string;
  account_type: string;
}): string {
  return record.account_type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(record.account_login)}/settings/installations/${record.installation_id}`
    : `https://github.com/settings/installations/${record.installation_id}`;
}

function toInstallationView(r: InstallationRecord): z.input<typeof installationView> {
  return {
    id: r.id,
    account: r.account_login,
    accountType: r.account_type,
    repositorySelection: r.repository_selection,
    status: r.status,
    manageUrl: manageInstallationUrl(r),
  };
}

export const githubConnectStart = defineOperation({
  name: "github.connectStart",
  description:
    "Start connecting a GitHub account to the org (ADR 0055): returns GitHub's install URL for the factory's App, carrying a fresh single-use `state` bound to this org and person (it expires in 15 minutes). GitHub sends the person back to the website's /integrations/github/setup with the installation, which github.connectInstallation verifies. Needs an org owner or admin.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({ url: z.string(), state: z.string(), expiresAt: z.string() }),
  redact: { output: (o) => ({ ...o, url: "[redacted]", state: "[redacted]" }) },
  async handler(input, ctx) {
    const slug = ctx.services.github.app.slug;
    if (!slug) throw new OperationError("unavailable", "the factory's GitHub App isn't configured");
    const state = randomToken();
    const expiresAt = new Date(Date.parse(ctx.now) + CONNECT_STATE_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_github_connect_states").values({
        state_hash: await sha256Hex(state),
        org_id: input.orgId,
        user_id: ctx.actor.id,
        created_at: ctx.now,
        expires_at: expiresAt,
        used_at: null,
      }),
    );
    return {
      url: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`,
      state,
      expiresAt,
    };
  },
});

export const githubConnectInstallation = defineOperation({
  name: "github.connectInstallation",
  description:
    "Finish connecting a GitHub App installation, from GitHub's redirect to /integrations/github/setup (ADR 0055). With `state` (a new install): the state must be the one this person started for the org, unused and unexpired (CSRF). Without it (`setup_action=update` from GitHub's settings): the installation must already be connected to an org this person administers. Either way the installation is checked as the App (`GET /app/installations/{id}`; an id GitHub doesn't know is refused) and the person must have access to it: it is on their own account, or their GitHub user token lists it. Then it is recorded (or refreshed) for the org. `setup_action=request` (an org member asked an owner to approve) records nothing.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({
    installationId: z.string().regex(/^\d{1,20}$/),
    setupAction: z.enum(["install", "update", "request"]).default("install"),
    state: z.string().min(16).max(200).optional(),
    /** The person's GitHub user token, only to prove access to an org-account installation. Never stored. */
    userAccessToken: z.string().min(1).max(500).optional(),
  }),
  output: z.object({
    outcome: z.enum(["connected", "updated", "requested"]),
    orgId: z.string().nullable(),
    installation: installationView.nullable(),
  }),
  redact: {
    input: (i) => ({
      ...i,
      state: i.state ? "[redacted]" : undefined,
      userAccessToken: i.userAccessToken ? "[redacted]" : undefined,
    }),
  },
  async handler(input, ctx) {
    const existing = (await ctx.db
      .selectFrom("core_github_installations")
      .selectAll()
      .where("installation_id", "=", input.installationId)
      .executeTakeFirst()) as InstallationRecord | undefined;

    let orgId: string;
    if (input.state) {
      const hash = await sha256Hex(input.state);
      const row = await ctx.db
        .selectFrom("core_github_connect_states")
        .selectAll()
        .where("state_hash", "=", hash)
        .executeTakeFirst();
      if (!row) {
        throw new OperationError(
          "forbidden",
          "this GitHub connection wasn't started here (unknown state)",
        );
      }
      if (row.user_id !== ctx.actor.id) {
        throw new OperationError(
          "forbidden",
          "this GitHub connection was started by someone else: start it again from the app",
        );
      }
      if (row.used_at) {
        throw new OperationError("forbidden", "this GitHub connection link was already used");
      }
      if (Date.parse(row.expires_at) <= Date.parse(ctx.now)) {
        throw new OperationError(
          "forbidden",
          "this GitHub connection link expired: start it again from the app",
        );
      }
      orgId = row.org_id;
      // Single use: the state is spent in this call's batch, or the batch fails.
      ctx.write(
        ctx.db
          .updateTable("core_github_connect_states")
          .set({ used_at: ctx.now })
          .where("state_hash", "=", hash)
          .where("used_at", "is", null),
      );
      ctx.guardChanged("state single use");
    } else if (existing) {
      orgId = existing.org_id;
    } else {
      throw new OperationError(
        "forbidden",
        "GitHub sent an installation the factory didn't ask for: connect it from the app",
      );
    }
    if (!(await isOrgAdmin(ctx.db, orgId, ctx.actor.id))) {
      throw new OperationError("forbidden", "connecting GitHub needs an org owner or admin");
    }
    if (existing && existing.org_id !== orgId) {
      throw new OperationError(
        "conflict",
        `the GitHub App's installation on ${existing.account_login} is already connected to another org`,
      );
    }
    if (input.setupAction === "request") {
      return { outcome: "requested" as const, orgId, installation: null };
    }

    // As the App: does this installation exist, and is it ours?
    const info = await ctx.services.github.getInstallation(input.installationId);
    if (!info) {
      throw new OperationError(
        "not_found",
        "GitHub doesn't know that installation of the factory's App: connect again from the app",
      );
    }
    await requireAccess(ctx, info, input.userAccessToken);

    const status = info.suspended ? ("suspended" as const) : ("active" as const);
    const record: InstallationRecord = {
      id: existing?.id ?? newId("githubInstallation"),
      org_id: orgId,
      installation_id: info.installationId,
      account_login: info.account.login,
      account_type: info.account.type,
      repository_selection: info.repositorySelection,
      status,
    };
    if (existing) {
      ctx.write(
        ctx.db
          .updateTable("core_github_installations")
          .set({
            account_login: record.account_login,
            account_type: record.account_type,
            repository_selection: record.repository_selection,
            status,
            updated_at: ctx.now,
          })
          .where("id", "=", existing.id),
      );
    } else {
      ctx.write(
        ctx.db.insertInto("core_github_installations").values({
          ...record,
          connected_by: ctx.actor.id,
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
      );
    }
    ctx.change({
      entity: "github_installation",
      id: record.id,
      before: existing ? { status: existing.status, account: existing.account_login } : null,
      after: { status, account: record.account_login, selection: record.repository_selection },
    });
    ctx.subject({ orgId });
    return {
      outcome: existing ? ("updated" as const) : ("connected" as const),
      orgId,
      installation: toInstallationView(record),
    };
  },
});

/** The person may connect this installation: it is their own account, or GitHub lists it for them. */
async function requireAccess(ctx: HandlerContext, info: InstallationInfo, userToken?: string) {
  const user = await ctx.db
    .selectFrom("core_user")
    .select("github_login")
    .where("id", "=", ctx.actor.id)
    .executeTakeFirst();
  const login = user?.github_login?.toLowerCase() ?? null;
  if (info.account.type === "User" && login && info.account.login.toLowerCase() === login) return;
  if (userToken) {
    let ids: string[] = [];
    try {
      ids = await ctx.services.github.userInstallationIds(userToken);
    } catch (err) {
      throw new OperationError(
        "forbidden",
        `couldn't confirm your access to the installation on ${info.account.login}: ${err instanceof Error ? err.message : String(err)}. Sign out and in again, then retry.`,
      );
    }
    if (ids.includes(info.installationId)) return;
  }
  throw new OperationError(
    "forbidden",
    `your GitHub account doesn't have access to the App's installation on ${info.account.login}`,
  );
}

export const githubInstallation = defineOperation({
  name: "github.installation",
  description:
    "The factory's GitHub App installation changed on GitHub (ADR 0025, 0055): repositories added or removed, the installation suspended, unsuspended or deleted. Keeps the org's installation record current: its status and which repositories it reaches (all or selected). A suspended or deleted installation is left out of what the org's projects can pick, and its tokens are refused by GitHub.",
  risk: "write",
  actors: ["intake"],
  permission: "signed-in",
  input: z.object({
    action: z.enum(["added", "removed", "suspended", "unsuspended", "deleted"]),
    installationId: z.string().regex(/^\d+$/),
    account: z.string().min(1).max(100),
    repositorySelection: z.enum(["all", "selected"]).optional(),
  }),
  output: z.object({ record: z.string().nullable() }),
  async handler(input, ctx) {
    const record = await ctx.db
      .selectFrom("core_github_installations")
      .selectAll()
      .where("installation_id", "=", input.installationId)
      .executeTakeFirst();
    if (!record) return { record: null };
    const status =
      input.action === "suspended"
        ? "suspended"
        : input.action === "deleted"
          ? "deleted"
          : input.action === "unsuspended"
            ? "active"
            : record.status;
    const selection = input.repositorySelection ?? record.repository_selection;
    if (status !== record.status || selection !== record.repository_selection) {
      ctx.write(
        ctx.db
          .updateTable("core_github_installations")
          .set({
            status,
            repository_selection: selection,
            account_login: input.account,
            updated_at: ctx.now,
          })
          .where("id", "=", record.id),
      );
      ctx.change({
        entity: "github_installation",
        id: record.id,
        before: { status: record.status, selection: record.repository_selection },
        after: { status, selection },
      });
    }
    ctx.subject({ orgId: record.org_id });
    return { record: record.id };
  },
});
