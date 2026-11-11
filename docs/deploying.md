# Deploying

The factory deploys from source with wrangler. CI runs on every PR and push to `main`; when it
passes on `main`, the Deploy workflow ships `main` to one Cloudflare account. Nothing in the repo
names an account or resource ID: the account comes from a repo variable, resources are found or
created by name.

## What deploys

Every folder under `apps/`, `packages/` or `local/` with a `wrangler.jsonc` is a deployable Worker.
Today that is:

| Worker | Folder | Public | Notes |
| --- | --- | --- | --- |
| `sf-engine` | `apps/engine` | `sf-engine.zerobsai.com` (runner channel + `/health` only) | Every operation (RPC for `sf-app`), work-item Workflows, the runner channel, cron (`* * * * *`). D1 `software-factory`, migrations from `packages/db/migrations`. Secrets `RUNNER_CHANNEL_SECRET`, `GH_APP_PRIVATE_KEY` |
| `sf-app` | `apps/app` | `sf-app.<subdomain>.workers.dev` | Dashboard, MCP surface, operations API |

A new Worker (a connector, say) is picked up automatically: add its `wrangler.jsonc` and it
deploys. Workers deploy in dependency order: a Worker that another binds to with a service
binding deploys first. `node scripts/deploy/deploy.ts list` prints the order.

The resources the Workers bind to are created by name when missing (`scripts/deploy/provision.ts`):

| Resource | How it gets created |
| --- | --- |
| D1 databases (`d1_databases[].database_name`) | `provision.ts`, before migrations, so a first deploy can migrate |
| R2 buckets (`r2_buckets[].bucket_name`) | `provision.ts` |
| Queues (producers, consumers, dead-letter queues) | `provision.ts`; wrangler never creates queues |
| KV namespaces (`kv_namespaces[]` with no `id`) | `wrangler deploy` provisions them |
| Workflows, Durable Objects, cron triggers | `wrangler deploy`, from the Worker's config |

Bind D1 by `database_name` and R2 by `bucket_name`, never by ID. Each D1 database's migrations
are applied once, from the first Worker (in deploy order) that sets `migrations_dir` for it.

## The pipeline

- **`.github/workflows/ci.yml`**, job `ci`: `pnpm install` (cached), `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, the deploy scripts' own tests, and `pnpm build` (a
  `wrangler deploy --dry-run` of every Worker). Turborepo's cache is kept between runs. `ci` is a
  required status check on `main`.
- **`.github/workflows/deploy.yml`** runs when CI passes on a push to `main`, or by hand
  (Actions → Deploy → Run workflow, or `gh workflow run deploy.yml`). In the GitHub environment
  `production` it runs, in order:
  1. `node scripts/deploy/provision.ts`: create missing D1 databases, R2 buckets and queues;
  2. `node scripts/deploy/deploy.ts migrate`: `wrangler d1 migrations apply <db> --remote`;
  3. `node scripts/deploy/deploy.ts workers`: `wrangler deploy` for each Worker.

  It deploys the commit CI passed on. Deploys never overlap and are never cancelled half way. If
  the API token is not set, the deploy job is skipped with a notice and nothing fails.

Migrations run before the new code, so a migration must work with the code already deployed
(add columns and tables; drop them in a later release).

## Setting it up

### Account ID

Repo variable `CLOUDFLARE_ACCOUNT_ID` (already set):

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --body <account-id>
```

### API token

Create a token at dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token,
scoped to the one account, with:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy Workers, Workflows, Durable Objects, cron triggers |
| Account | D1: Edit | Create databases, apply migrations |
| Account | Workers KV Storage: Edit | Provision KV namespaces |
| Account | Workers R2 Storage: Edit | Create R2 buckets |
| Account | Queues: Edit | Create queues |
| Account | Account Settings: Read | wrangler reads account details |
| Zone | Workers Routes: Edit | Only once a Worker uses `routes` or a custom domain (none do yet) |

Add it as a repo secret (it prompts for the value, so it stays out of shell history):

```sh
gh secret set CLOUDFLARE_API_TOKEN
```

Then run the first deploy: `gh workflow run deploy.yml`, or push to `main`. The environment
`production` exists already; add protection rules to it (a required reviewer, say) in Settings →
Environments if you want a human to approve each deploy.

### Branch protection

`main` requires the `ci` check. No reviews are required, so the owner merges their own PRs once
`ci` is green. Admins are held to it too. To set it again (or on a fork):

```sh
gh api -X PUT repos/{owner}/{repo}/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": false, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

`factory/verify` joins the required checks at the bootstrap (V1 step 5), pinned to the App (ADR
0037). Until then the App posts it but it isn't required: it fails every PR the factory didn't
open, and would block the sessions still building V1. To require it (keeping `ci`):

```sh
gh api -X PATCH repos/{owner}/{repo}/branches/main/protection/required_status_checks --input - <<'JSON'
{ "strict": false, "checks": [{ "context": "ci", "app_id": 15368 }, { "context": "factory/verify", "app_id": 5705909 }] }
JSON
```

### The repository ruleset

Only repo admins may create, update or delete branches other than `factory/**` and `main`, so the
App (not a bypass actor) can push only `factory/*` (ADR 0052). The ruleset is `FACTORY_RULESET` in
`packages/core/src/verify/onboarding.ts` (applied to software-factory on 2026-11-11); apply it with
`gh api -X POST repos/{owner}/{repo}/rulesets --input <that JSON>`. `project.checkGitHub` reports
whether a project's repo has both the ruleset and the required check.

### The GitHub App

Webhook URL `https://software-factory.zerobsai.com/webhooks/github` (a Workers route on sf-engine in
front of sf-app's domain; the deploy token needs Zone → Workers Routes: Edit), secret
`GH_APP_WEBHOOK_SECRET` (synced to sf-engine). Permissions: contents and pull requests (write),
checks (write), administration (read), metadata (read). Events: pull request, check suite, check
run, push, installation, installation repositories (`APP_REQUIREMENTS` in
`packages/connector-github`).

## Deploying by hand

From a checkout, logged in with `wrangler login` or with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` exported:

```sh
pnpm install
node scripts/deploy/provision.ts --dry-run   # what would be created
node scripts/deploy/deploy.ts                # provision + migrate + deploy every Worker
```

## Not yet

- **Preview deploys per PR.** `wrangler versions upload --preview-alias pr-<n>` would give each
  PR a URL, but a preview version uses the production bindings, so it would read and write the
  production D1. It waits for separate preview resources.
- **Secrets on the Workers** are synced by the deploy job from repo secrets with
  `wrangler secret bulk`: `sf-app` gets the Better Auth and GitHub App secrets; `sf-engine` gets
  `RUNNER_CHANNEL_SECRET` and `GH_APP_PRIVATE_KEY`. Unset ones are skipped, and the engine degrades
  (the runner channel answers 503) instead of failing to deploy.
