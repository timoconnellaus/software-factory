# Handoff

Where the build stands, for a fresh session. Read this first, then
[`parallel-work.md`](parallel-work.md) if you are building alongside other sessions, then the spec
of whatever you pick up.

Last refreshed: 2026-11-11 (V1 step 1, core + engine). V1 is defined in [`v1-scope.md`](v1-scope.md).

## The product
A software factory on Cloudflare. Work comes in from anywhere, agents take it through triage, spec,
build and verify, and people step in only at gates. Runners are adapters; Orca is the first. Small
team, multi-org (Better Auth). Plan: [`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md).
Architecture: [`architecture.md`](architecture.md). UI: [`ui-plan.md`](ui-plan.md).

## How we work
- Each slice goes interview → spec in `docs/specs/NN-*.md` → build → PR → merge.
- Builds are done by agents in worktrees, briefed from the spec plus this file. Keep a
  `WIP.md` at the repo root while working so a build can be resumed (it is gitignored).
- **Merge commits only, never rebase or force-push.** Resolve conflicts by keeping both sides.
- Parallel builds use **disjoint migration and ADR number ranges** ([`parallel-work.md`](parallel-work.md)).
- Use **Node 24** (`.nvmrc`). Plain `node` on this Mac may be another version: put
  `$HOME/.nvm/versions/node/v24.21.0/bin` first on `PATH`.

## Standing rules
See [`AGENTS.md`](../AGENTS.md). In short: operations first, no ambient authority, policy in code
and not AI-configurable, model roles not ids, runners are adapters, nothing reaches main except
through `factory/verify` and the merge gate. The repo is public: no secrets, no account IDs.

## Merged on main
| PR | What |
| --- | --- |
| Design | Product plan, architecture diagram, UI plan, mockups, design system, research |
| #2 | Spec 00, scaffold: pnpm + Turborepo + Biome, placeholder apps and packages; AGENTS/CONTEXT; ADRs 0001–0032; specs 00–04 and 10–14 |
| #3 | Spike: auth, orgs and multi-session (`spikes/auth-multisession`, proposed ADR 0120) |
| #4 | CI and deploy workflows, provisioning script ([`deploying.md`](deploying.md)) |
| #5 | Spike: Workflow per work item and the gate (`spikes/workflow-gate`, proposed ADR 0110) |
| #6 | Spike: runner contract, `runner-orca` over the `orca` CLI, `runner-local` sketch (`spikes/runner-orca`, ADR 0100) |
| #7 | [Design review](reviews/2026-11-11-design-review.md) |
| #8 | Custom domain and Worker secrets; `sf-app` and `sf-engine` deployed as placeholders (`/api/health` only) |
| #9 | [Review decisions](reviews/2026-11-11-review-decisions.md) |
| #10 | Review decisions applied to the docs: ADRs 0033–0047, amendments to 0001–0032, vocabulary (connector, autonomy policy, project template, Question, `docs/specs/`), R1 specs split into milestones, spec 15 |
| #11 | [V1 scope](v1-scope.md): the dogfooding factory |
| V1-1 | Core + engine: `core_*` schema, operations + `invoke()` + gate, the work-item Workflow, the signed runner channel, GitHub App job tokens. ADRs 0050–0054; spike ADRs 0100 and 0110 promoted |

## In flight
- Nothing recorded. Spike ADRs 0100 and 0110 are promoted into `docs/adr/`; 0120 (auth) moves when
  the app session promotes it.

## Contracts for the V1 sessions (from V1-1, core + engine)
Everything below exists on `main`, with tests. Read the package READMEs for detail.

**Every session**
- State changes only through operations (`packages/core`, `describeOperations()` lists them). In V1
  they all run in `sf-engine` (ADR 0051). Refusals are `OperationError` codes: `invalid_input`,
  `forbidden`, `denied`, `killed`, `fenced`, `conflict`, `not_found`, `unavailable`, `bad_approval`.
- D1 is `software-factory`; migrations live in `packages/db/migrations` (blocks in
  [`parallel-work.md`](parallel-work.md)); typed access via `createDb` (Kysely, ADR 0050).
- A project's policy is `.factory/policy.json` on its default branch (ADR 0054). A project with no
  valid policy refuses new work and every agent call (fail closed).

**App session (step 2: sign-in, Inbox, New work, work item detail, review packet)**
- Better Auth on `core_user` / `core_session` / `core_account` / `core_verification` /
  `core_organization` / `core_member` / `core_invitation`: field mapping in
  [`packages/db/README.md`](../packages/db/README.md). Fill `core_user.github_login` on GitHub sign-in.
  Create the Personal org with `kind = 'personal'` and the user as `owner`.
- Bind D1 `software-factory` (no `migrations_dir`: the engine applies them) and a service binding
  `ENGINE` → `sf-engine`, entrypoint `EngineApi`. Call
  `env.ENGINE.invoke(name, input, { actor: { type: "human", id: userId }, origin: { surface: "app" } })`;
  it returns `{ ok: true, result }` or `{ ok: false, error: { code, message } }`. Pass an
  `idempotencyKey` for form submits.
- Operations by screen:
  - Setup: `project.create`, `project.list`, `policy.sync` (until the connector does it), `runner.register`
    (returns the runner key once), `runner.rotateKey`, `runner.list`.
  - New work: `workItem.previewRouting { projectId }`, `workItem.create { projectId, title?, body, source: "app", eventId }`.
  - Inbox: `inbox.list { orgId? }` (gates and questions assigned to you, running items, your runners'
    health, WIP holds). Decide with `spec.approve`, `spec.requestChanges { note }`,
    `review.merge { openedFullDiff }`, `review.sendBack { note, openedFullDiff }`, `approval.decide`,
    `question.answer`, `question.acceptDefaults`. A repeat decision returns `alreadyDecided: true`.
  - Work item detail: `workItem.get` (item, stages with the spec-skip reason, spec, questions, gates,
    runs, latest review packet), `workItem.timeline` (the audit journal), `workItem.cancel`.
  - Kill switches: `killSwitch.set { scope: "org" | "project", id, on }`.
- Deep links the outbox `notify` rows carry: `/?item=<workItemId>` and `/work/<workItemId>`.

**Runner session (step 3: runner-host, runner-orca, harness-claude)**
- Build against `@software-factory/runner-contract`: `httpControlPlane` (signed client),
  `RunnerAdapter`, the wire schemas, `RESULT_FILE` and the stage result schemas. The host's loop is
  in [`packages/runner-contract/README.md`](../packages/runner-contract/README.md).
- Channel: `https://sf-engine.zerobsai.com/runner/v1/*`. Runner id and key come from
  `runner.register` (a person, through the app). Heartbeat every ~20 s; the lease lasts 10 minutes.
- The job carries no token: call `token(jobId, fencingToken)` for a repo-scoped App token, push only
  `job.branch`, hand back `{ branch, headSha, result }`. A `409 fenced|killed` means stop now.
- Prompts already end with the result file and its JSON shape; the harness writes it, the host
  passes it through untouched and never commits it.

**Verify + GitHub connector + incidents session (step 4)**
- The Workflow runs a `verify` job (role `review`) and records the packet with
  `reviewPacket.record` from the runner's `verifyResult`. Replace the verdict source with CI check
  runs on the head SHA (spec 04), add holdout tests, and post `factory/verify`; keep calling
  `reviewPacket.record` (extend its `sections`).
- `pr.open` already opens the PR through the App and reports `touchesFactoryConfig`; `pr.merge` is the
  merge gate (risk `merge`, or `self-modify` for `.factory/` diffs) and merges through the App.
- Connector work left: the push webhook (fail a run on an App push outside its run branch, ADR 0052),
  `policy.sync` on default-branch pushes, the repo ruleset and branch protection check at onboarding.
- Incidents: `incident.open`, and `review.sendBack` opens one automatically. The Workflow opens one
  when a run's retries are exhausted.

## Next
R1 is built in three internal milestones ([`specs/README.md`](specs/README.md)):
1. **(a) Core loop**, one user and one repo: spec 01 first (everything builds on it), then 02 and 03
   in parallel, then 04; 15 and the (a) parts of 10–14 alongside. The security changes (job tokens,
   fencing, `factory/verify` pinning) are part of 03 and 04, not a separate track.
2. **(b) Orgs and multi-session**: the (b) parts of 10–14.
3. **(c) Decision domains, clarification and shared runners**: the (c) parts of 10–14.

First projects to run through the factory: crm (Relationship OS), software-factory (itself),
channel-manager.

## Open questions
Resolved by the review decisions (2026-11-11):
- Kill-switch scope (0006): per org and per project ([ADR 0044](adr/0044-kill-switch-scope.md)).
- How `.factory/` changes reach the control plane (0009): read from the default branch only, cached
  by SHA, refreshed by the push webhook ([ADR 0036](adr/0036-policy-from-the-default-branch.md)).
- What "small" means for skipping the spec (0013): the LLM triage judgement, logged with its reason.
- Mid-run local takeover (0021): the fencing token is bumped and the cloud run stops
  ([ADR 0035](adr/0035-lease-fencing-and-one-branch-per-run.md)).
- Runner push credentials (0025): per-job, repo-scoped App tokens ([ADR 0033](adr/0033-per-job-github-app-tokens.md)).
- Decision domains with no owner (0029): the project approver, as backup owner ([ADR 0042](adr/0042-one-question-object.md)).
- Client as org vs factory (0032): its own org ([ADR 0043](adr/0043-a-client-is-its-own-org.md)).
- Planning scope in v1 (0028): settled by the UI interview and ADR 0042.

Answered by V1-1 (core + engine):
- Job transport to runners (0016): pull, heartbeat then claim.
- Where the model-role map lives (0018): `packages/core/src/model-roles.ts`, overridable per project in `.factory/policy.json`.
- Lease length (0021): 10 minutes, renewed by heartbeat.

Still open:
- How review should work on the first projects (crm, software-factory, channel-manager).
- Cascade and depth limits (0006).
- Token usage reporting (0011).
- Project template tiers between `minimal` and `product` (0026).
- Whether holdout tests are committed after merge (0034).
- Whether harness subscription terms allow unattended or team use of a runner (0033).
- Whether `presets/` should be renamed now that "preset" is retired as a word.
- Speculative continuation past a gate: designed for (0007), not built in R1.

## Needs the human
- **`RUNNER_CHANNEL_SECRET`** as a repo secret (`openssl rand -base64 48 | gh secret set RUNNER_CHANNEL_SECRET`):
  the deploy syncs it to `sf-engine`. Until then the runner channel answers 503.
- A repository ruleset on software-factory letting the App push only `factory/*` (ADR 0052).
- A GitHub App per org, and branch protection requiring `factory/verify` from the App with
  `enforce_admins` on (spec 04).
- The Mac mini set up as the first runner (Orca + Claude Code signed in), with no `gh`, SSH agent or
  cloud credentials visible to the harness (ADR 0033).
- VAPID keys for web push as Worker secrets (spec 15).
