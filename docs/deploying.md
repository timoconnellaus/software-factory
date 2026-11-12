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
| `sf-app` | `apps/app` | `software-factory.zerobsai.com` | Dashboard (TanStack Start, built with `vite build` before `wrangler deploy`), GitHub sign-in. D1 `software-factory` (Better Auth tables), service binding `ENGINE` → `sf-engine#EngineApi`. Secrets `BETTER_AUTH_SECRET`, `GH_APP_CLIENT_SECRET`; var `ALLOWED_GITHUB_LOGINS` |

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
  3. `node scripts/deploy/deploy.ts workers`: `wrangler deploy` for each Worker. A Worker that
     declares `DEPLOYED_SHA` in its vars gets `--var DEPLOYED_SHA:<the deployed commit>`, and one
     that declares `RUNNER_SHA` gets `--var RUNNER_SHA:<the last commit that changed runner code>`
     (below). Only `sf-engine` declares them.

  It deploys the commit CI passed on, checked out with full history (`fetch-depth: 0`). Deploys never overlap and are never cancelled half way. If
  the API token is not set, the deploy job is skipped with a notice and nothing fails.

Migrations run before the new code, so a migration must work with the code already deployed
(add columns and tables; drop them in a later release).

### What runners are asked to run (ADR 0360, 0520)

Runner hosts update themselves to the commit `sf-engine`'s heartbeat names as `desiredVersion`.
That is `RUNNER_SHA`: the last commit on `main`'s first-parent line, at or before the deployed one,
that changed runner code, so an engine-only or app-only deploy moves no runner.
`scripts/deploy/lib.ts` works it out with git:
- **runner code** is `local/runner-host`, `packages/runner-*`, `packages/harness-*` and their
  workspace dependency closure (`dependencies`, `optionalDependencies` and `peerDependencies` on
  `workspace:` versions, read from the package.json files), plus the root `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.nvmrc`. Not `devDependencies`;
- `git log -1 --first-parent <deployed> -- <those paths>`. In a shallow clone it gives up and
  leaves `RUNNER_SHA` unset; the engine then answers `DEPLOYED_SHA`, which is safe (runners just
  update more often).

A `workflow_dispatch` run from a branch computes it on that branch. That fails safe: runners
refuse a desired commit that isn't on `origin/main` and keep claiming on their current code.

`node -e 'import("./scripts/deploy/lib.ts").then(m => console.log(m.runnerSha("HEAD") ?? "unknown"))'`
prints it for a local checkout.

**The engine runs ahead of runners.** A runner behind the desired commit keeps claiming on its old
code until it is idle (with caps at 30 and 60 minutes), so every engine change must keep serving
older runners. The rule is `RUNNER_COMPAT`'s comment in `packages/runner-contract/src/types.ts`
(ADR 0520): optional new request fields, enums only grow, new kinds of job behind a capability, and
anything else bumps `RUNNER_COMPAT` in the same PR, which makes every older runner stop claiming at
its next heartbeat and update. Never bump `CONTRACT_VERSION`: the engine would refuse older runners'
heartbeats, and they could never learn to update.

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

### Protecting `main`

The factory never changes protection: its App has `administration: read` only (ADR 0280). Setup's
**Protect `main`** step offers the generated ruleset (`<repo>-default-branch.json`: a PR, `ci` and
`factory/verify` pinned to the App and up to date, no force pushes, no deletion, no bypass), a link
to `https://github.com/<owner>/<repo>/settings/rules`, and **Check now**. On GitHub: **New ruleset →
Import a ruleset → choose the file → Create**. If the repo has no ruleset confining the App to
`factory/*` (ADR 0052), Setup offers `<repo>-factory-branches.json` too; import it the same way.

If the import page refuses a file, a repo admin can apply the same JSON with
`gh api -X POST repos/{owner}/{repo}/rulesets --input <file>`.

#### software-factory itself (as of 2026-11-11)

What GitHub reports today (read with the owner's `gh`, nothing changed):
- **Classic branch protection** on `main`: requires `ci` (pinned to GitHub Actions, 15368), not
  strict, `enforce_admins` on, no PR required, force pushes and deletion blocked.
- **Ruleset** `factory: confine App pushes to factory/*` (id 27006249): active, `~ALL` minus
  `refs/heads/factory/**` and `~DEFAULT_BRANCH`, creation/update/deletion, admins bypass. This is
  exactly `<repo>-factory-branches.json`, so Setup won't offer that file.
- No ruleset applies to `main` (`GET /rules/branches/main` is empty), and `factory/verify` isn't
  required anywhere.

So Setup's Protect `main` step is red with: a pull request isn't required, `factory/verify` not
required, `ci` not required, force pushes are allowed, the branch can be deleted (the classic rule
blocks the last two, but the factory checks rulesets only; a warning says so).

**When to switch:** once the factory opens its own PRs for software-factory (V1 step 5: the project
has its policy and a runner is online) and the PRs built by hand-run sessions are merged. With no
bypass, a PR that `factory/verify` hasn't passed can't merge, and `factory/verify` fails every PR
the factory didn't open, so switching earlier blocks those sessions (#20, #22 and #24 merged with it
red as bootstrap exceptions).

**What to click, then:**
1. In the GitHub App's settings (GitHub → Settings → Developer settings → GitHub Apps →
   software-factory-zerobsai → **Permissions & events**), under **Subscribe to events**, tick
   **Repository ruleset** and **Branch protection rule**. Leave **Administration** at **Read-only**.
   Setup lists these two events until they're ticked.
2. In Setup → **Protect `main`** → **Download ruleset** (`software-factory-default-branch.json`).
3. **Open GitHub rulesets** → **New ruleset → Import a ruleset** → choose the file. Check what GitHub
   shows: Enforcement **Active**, Bypass list **empty**, Target **Default branch**; rules **Restrict
   deletions**, **Block force pushes**, **Require a pull request before merging** (0 approvals),
   **Require status checks to pass** with **Require branches to be up to date** on and the checks
   `ci` and `factory/verify` (source: the software-factory-zerobsai App). → **Create**.
4. Back in Setup → **Check now** → ✓.
5. Delete the classic rule: Settings → Branches → the `main` rule → **Delete**. The ruleset covers all
   of it. Check now again: the classic-protection warning goes away.

To protect `main` before the factory opens PRs, do steps 1–3 but remove `factory/verify` from the
status checks before **Create**. Setup then stays red with "`factory/verify` not required", which is
true. When it's time, edit the ruleset (Settings → Rules → Rulesets → `factory: protect the default
branch` → Require status checks → **Add checks** → `factory/verify`, source the App) and Check now.

### The GitHub App

**Setup URL** `https://software-factory.zerobsai.com/integrations/github/setup`, with **Redirect on
update** on (ADR 0055): GitHub sends people there after they install the App or change its
repositories, and Setup's **Connect GitHub** depends on it. "Request user authorization (OAuth)
during installation" stays off (sign-in already authorizes).

Webhook URL `https://software-factory.zerobsai.com/webhooks/github` (a Workers route on sf-engine in
front of sf-app's domain; the deploy token needs Zone → Workers Routes: Edit), secret
`GH_APP_WEBHOOK_SECRET` (synced to sf-engine). Permissions: contents and pull requests (write),
checks (write), administration (**read only**: write would let the App delete repositories, ADR
0280), metadata (read). Events: pull request, check suite, check run, push, installation,
installation repositories, repository ruleset, branch protection rule (`APP_REQUIREMENTS` in
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
