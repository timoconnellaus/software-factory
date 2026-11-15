# Deploying

The engine and the website deploy from source with wrangler. CI runs on every PR and push to
`main`; when it passes on `main`, the Deploy workflow ships `main` to one Cloudflare account.
Nothing in the repo names an account or resource ID: the account comes from a repo secret, and
resources are found or created by name.

## What deploys

Every folder under `apps/`, `packages/` or `local/` with a `wrangler.jsonc` is a deployable Worker.
Today that is:

| Worker | Folder | Public | Notes |
| --- | --- | --- | --- |
| `sf-engine` | `apps/engine` | `sf-engine.zerobsai.com` (runner channel, client door, `/health`) | Every operation (RPC for `sf-app`), the runner channel, the client door, the GitHub webhook, the `factory` MCP server and plugin triggers, cron (`* * * * *`). D1 `software-factory`, migrations from `packages/db/migrations`. The Durable Object `ClientHub`. The rate limiting binding `MOBILE_NONCE_LIMIT` (in `wrangler.jsonc`, nothing to provision). The Worker Loader binding `LOADER` (plugins as Dynamic Workers; Workers Paid plan; see "Plugins and gateways" below). Secrets `RUNNER_CHANNEL_SECRET`, `GH_APP_PRIVATE_KEY`, `GH_APP_WEBHOOK_SECRET`, `FLOW_GATEWAY_KEY` |
| `sf-app` | `apps/app` | `software-factory.zerobsai.com` | GitHub sign-in, the device connect pages and the GitHub App's setup redirect (TanStack Start, built with `vite build` before `wrangler deploy`). D1 `software-factory` (Better Auth tables), service binding `ENGINE` → `sf-engine#EngineApi`. Secrets `BETTER_AUTH_SECRET`, `GH_APP_CLIENT_SECRET`; var `ALLOWED_GITHUB_LOGINS` |

A new Worker (a gateway, say) is picked up automatically: add its `wrangler.jsonc` and it
deploys. Workers deploy in dependency order: a Worker that another binds to with a service
binding deploys first. `node scripts/deploy/deploy.ts list` prints the order.

The resources the Workers bind to are created by name when missing (`scripts/deploy/provision.ts`).
Today the only one is the D1 database; no Worker binds R2, a queue or KV:

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
  `pnpm typecheck`, `pnpm test`, the repo guards and deploy scripts' tests
  (`node --test "scripts/*/*.test.ts"`), and `pnpm build` (a
  `wrangler deploy --dry-run` of every Worker). Turborepo's cache is kept between runs. `ci` is a
  required status check on `main`.
- **`.github/workflows/deploy.yml`** runs when CI passes on a push to `main`, or by hand
  (Actions → Deploy → Run workflow, or `gh workflow run deploy.yml`). In the GitHub environment
  `production` it runs, in order:
  1. `node scripts/deploy/desktop-floor.ts`: refuse a `DESKTOP_MIN_PROTOCOL` no published desktop
     build speaks;
  2. `node scripts/deploy/provision.ts`: create missing D1 databases, R2 buckets and queues;
  3. `node scripts/deploy/deploy.ts migrate`: `wrangler d1 migrations apply <db> --remote`;
  4. `pnpm build`, then `node scripts/deploy/deploy.ts workers`: `wrangler deploy` for each Worker.
     A Worker that declares `DEPLOYED_SHA` in its vars gets `--var DEPLOYED_SHA:<the deployed
     commit>`, and one that declares `RUNNER_SHA` gets `--var RUNNER_SHA:<the last commit that
     changed runner code>` (below). Only `sf-engine` declares them;
  5. sync each Worker's secrets from the repo secrets with `wrangler secret bulk` (below).

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

Repo secret `CLOUDFLARE_ACCOUNT_ID` (already set). It is a secret, not a variable, so that Actions
masks it in this public repository's logs (an account ID is not a credential, but it isn't
published either):

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID
```

### API token

Create a token at dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token,
scoped to the one account, with:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy Workers, the Durable Object, cron triggers, secrets |
| Account | D1: Edit | Create databases, apply migrations |
| Account | Account Settings: Read | wrangler reads account details |
| Zone | Workers Routes: Edit | The custom domains and `sf-engine`'s route for `/webhooks/*` on the website's host |

Add Workers KV Storage, Workers R2 Storage or Queues (Edit) only when a Worker binds one; none does
now.

Add it as a repo secret (it prompts for the value, so it stays out of shell history):

```sh
gh secret set CLOUDFLARE_API_TOKEN
```

Then run the first deploy: `gh workflow run deploy.yml`, or push to `main`. The environment
`production` exists already; add protection rules to it (a required reviewer, say) in Settings →
Environments if you want a human to approve each deploy.

### Secrets
The deploy job copies these repo secrets into the Workers with `wrangler secret bulk`. Unset ones
are skipped, and the Worker degrades instead of failing to deploy.

| Worker | Secret | What |
| --- | --- | --- |
| `sf-engine` | `RUNNER_CHANNEL_SECRET` | The runner channel's master secret. Unset: the channel answers 503. |
| | `GH_APP_PRIVATE_KEY` | The GitHub App's key: installations, a run's push token, the `github` gateway. Unset: GitHub calls are refused as `unavailable`. |
| | `GH_APP_WEBHOOK_SECRET` | Checks the App's webhook. Unset: the webhook answers 503. |
| | `FLOW_GATEWAY_KEY` | Seals gateway secrets (below). |
| `sf-app` | `BETTER_AUTH_SECRET` | Better Auth's session secret. |
| | `GH_APP_CLIENT_SECRET` | GitHub sign-in. |

Vars are in each `wrangler.jsonc`: `sf-engine`'s `GH_APP_ID`, `GH_APP_SLUG`, `PUBLIC_BASE_URL`,
`DESKTOP_MIN_PROTOCOL` and the phone sign-in's; `sf-app`'s `GH_APP_CLIENT_ID`,
`BETTER_AUTH_URL` and `ALLOWED_GITHUB_LOGINS` (who may sign in; empty lets nobody in).

### Protecting `main`
`main` has classic branch protection: the `ci` check is required, force pushes and deletion are
blocked, and admins are not exempt. The ruleset `factory: confine App pushes to factory/*` keeps the
GitHub App's pushes to `factory/**` branches, which is where the item's branch
(`factory/flow-<key>-<number>`) lives. GitHub's `factory/**` matches one path level only, so an
item's branch name must not contain another `/`. The old generated ruleset `factory: protect the
default branch` is disabled; nothing requires `factory/verify` any more.

### The GitHub App
**Setup URL** `https://software-factory.zerobsai.com/integrations/github/setup`, with **Redirect on
update** on (ADR 0055): GitHub sends people there after they install the App or change its
repositories. A project's Settings tab in the desktop app starts the connection
(`github.connectStart`). "Request user authorization (OAuth) during installation" stays off
(sign-in already authorizes).

Webhook URL `https://software-factory.zerobsai.com/webhooks/github` (a Workers route on sf-engine in
front of sf-app's domain), secret `GH_APP_WEBHOOK_SECRET`. The tokens the engine mints ask for
contents and pull requests (write), checks (read) and metadata (read), so the App needs at least
those. Events: the engine reads installation and installation repositories
(`apps/engine/src/webhooks.ts`) and acknowledges and ignores every other event.

## The desktop app's releases
`.github/workflows/desktop-release.yml` (spec 40 M4) builds, signs, notarizes and uploads the macOS
app to R2 bucket `sf-desktop-releases`, served at `https://downloads.zerobsai.com/desktop` (a custom
domain on the bucket, set up once with `wrangler r2 bucket domain add`). Every push to `main` that
touches the app or anything it bundles publishes a **canary** (`0.1.<run>`). **Stable is off**: see
"Before stable releases" below. The workflow runs in the `release` environment. Its secrets:

| Secret | What |
| --- | --- |
| `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD` | The Developer ID Application certificate and its key (base64 .p12) |
| `MACOS_SIGNING_IDENTITY` | `Developer ID Application: …` |
| `APPLE_TEAM_ID` | The Team ID |
| `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` | An App Store Connect API key (Developer role) for `notarytool` |
| `DESKTOP_R2_ACCESS_KEY_ID`, `DESKTOP_R2_SECRET_ACCESS_KEY` | An R2 API token scoped to `sf-desktop-releases` only (below) |
| `MACOS_KEYS_PROFILE` | Optional. The key helper's Developer ID provisioning profile (base64, one line; spec 40 M4b, "Owner checklist"). Without it a release ships without `SF Keys.app` and says so; with it the helper is added at `postPackage`, notarized again and checked, and delta patches are off |

It also reads the repo secret `CLOUDFLARE_ACCOUNT_ID` (for the R2 endpoint) and, for stable,
`DESKTOP_STABLE_ENABLED`.

**The upload token (owner, once).** The upload no longer uses the repo-wide `CLOUDFLARE_API_TOKEN`,
which every workflow can read: anyone who could run a workflow could publish a build the apps
install. Create a bucket-scoped token instead:
1. Cloudflare dashboard → R2 → *Manage R2 API Tokens* → *Create API token*.
2. Permission **Object Read & Write**, *Apply to specific buckets only*: `sf-desktop-releases`. No TTL
   needed; no IP filter (GitHub's runners have no fixed IPs).
3. Copy the *Access Key ID* and *Secret Access Key* into the `release` **environment** secrets (not
   repo secrets) as `DESKTOP_R2_ACCESS_KEY_ID` and `DESKTOP_R2_SECRET_ACCESS_KEY`.
4. If `CLOUDFLARE_API_TOKEN` has *Workers R2 Storage: Edit* only for the desktop upload, take that
   permission off it (the deploy workflow's D1/Workers permissions stay).

Until step 3 is done a push to `main` skips the release: the workflow checks for the two secrets
first and, without them, builds, signs, notarizes and uploads nothing, leaving one notice in the
job summary (it doesn't fail). A manual run without them fails.

**What the upload does.** `apps/desktop/scripts/publish-release.ts` refuses, before building, a
version that isn't higher than the channel's published one or that is already in the bucket. It
fails closed: only a real 404 counts as "not published"; missing credentials, a 403 or a network
error stop the run. It
uploads the archive and the download under versioned names (`…-0.1.42.app.tar.zst`, `…-0.1.42.zip`,
cached immutably and never overwritten), then the unversioned download, then the manifests last,
rewritten to name the versioned archive. A client never sees a manifest whose archive or hash isn't
there yet. A run that fails halfway is published again as a new version.

**Before stable releases (owner).** A tag-triggered workflow runs the workflow file *at the tagged
commit*, so anyone who can push a tag could run their own copy of it with the Developer ID, the App
Store Connect key and the upload token, and factory job tokens have `contents: write`. So stable is
not tag-triggered: it will be a manual run of the workflow on `main` (channel `stable`, a version),
which runs main's own file. It is refused until the variable `DESKTOP_STABLE_ENABLED` is `true`.
**Where the `release` environment stands.**

| | Step | Status | Needed before |
| --- | --- | --- | --- |
| 1 | Settings → Environments → `release` → *Deployment branches and tags*: **Selected branches and tags**, with the branch `main` only, no `v*` tag rule | **Done** (2026-11-12) | canary |
| 2 | The bucket-scoped upload token, `DESKTOP_R2_ACCESS_KEY_ID` / `DESKTOP_R2_SECRET_ACCESS_KEY` in the environment ("The upload token" above) | Owner | **canary**: nothing is published without it |
| 3 | Same page as 1: *Required reviewers*: add yourself. Leave **Prevent self-review** unticked while you are the only reviewer (you merge, so you trigger the runs you approve). Untick **Allow administrators to bypass configured protection rules** | Owner | stable |
| 4 | Settings → Rules → Rulesets → *New tag ruleset* "release tags": target `v*`, enforcement *Active*, rules **Restrict creations**, **Restrict updates** and **Restrict deletions**, bypass list **Repository admin** only. (The workflow uses no tags; this stops a stray `v*` tag from ever meaning anything.) | Owner | stable |
| 5 | Then set the repo variable `DESKTOP_STABLE_ENABLED` to `true` | Owner, last | stable |

Canary needs 1 (done) and 2. Stable needs all five. Step 3 also guards canary: with a required
reviewer, each canary run waits for an approval. If that's too much friction for canary, rely on
step 1 (main only, so only a merged commit's workflow can reach the secrets) and add the reviewer
just before turning stable on.

First install: download `https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip`,
unzip and move it to `/Applications`. After that the app updates itself; the app refuses an update
that isn't a higher version, isn't signed with its own Team ID, or that Gatekeeper rejects.

## Plugins and gateways

- **Worker Loader.** `apps/engine/wrangler.jsonc` binds `worker_loaders: [{ binding: "LOADER" }]`.
  Each plugin runs as a Dynamic Worker loaded through it (`packages/plugins`), with
  `globalOutbound: null`. Nothing to provision, but Dynamic Workers need the **Workers Paid plan**;
  on a Free account the deploy fails on this binding. Billing: 1,000 unique Dynamic Workers a
  month included, then $0.002 per Dynamic Worker per day; requests and CPU at the Workers
  Standard rates. A worker is one plugin version (its org and its code's hash), so editing a
  plugin makes a new one.
- **`FLOW_GATEWAY_KEY`** (engine secret, any long random string, e.g. `openssl rand -base64 32`).
  Gateway secrets are sealed with AES-GCM under a key derived from it. Set it as a repo secret
  of the same name and the deploy job syncs it with the others. Unset: saving a gateway secret
  is refused (`unavailable`), and gateways with `auth: { kind: "none" }` still work. Changing it
  makes every stored gateway secret unreadable; save them again.
- **Public routes** on `sf-engine.zerobsai.com`: `POST /flow/mcp` (the engine's MCP server; a
  bearer token issued per claimed flow run) and `POST /flow/triggers/<pluginId>/<name>?key=…`
  (a plugin's trigger; the key is the check). No route or DNS change: the engine's custom domain
  already serves every path.

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
