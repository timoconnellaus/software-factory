# Context: domain glossary

Use these words exactly, in code, docs and UI copy. Add to this file when a new term earns its place.

Renamed 2026-11-11 ([review decisions](docs/reviews/2026-11-11-review-decisions.md)): gatekeeper →
**connector**; preset → **autonomy policy** or **project template**; `docs/stages/` → `docs/specs/`;
planning session → **interview session**, now a view over **questions**.

## The organisation

**Org**
A group of users with members, roles and invitations (Better Auth organization plugin). Every user
gets a **Personal** org. An org owns factories and a GitHub App installation; runners are shared into
it by their owners. A client is its own org (ADR 0043).
_Avoid_: team (except the Team view in the UI), workspace, tenant, account (an account is a
signed-in session)

**Factory**
The layer between org and project: a group of projects with their autonomy policies, floor and
runners. In prose, "the software factory" is the product as a whole; don't use "factory" for the
control plane, a Workflow or a gate.
_Avoid_: pipeline (for the whole thing), instance, control plane (that is the Cloudflare side)

**Project**
One repo inside a factory, configured by its committed `.factory/` directory.
_Avoid_: repo (when you mean the configured unit), app

**Requester**
The user a work item is for. Placement rules such as `route: requester-first` prefer the
requester's own runners.
_Avoid_: owner, reporter, author

**Approver**
A user allowed to decide a gate on a project, set per project in `.factory/` (and per decision
domain where domains are declared).
_Avoid_: reviewer (that is the independent review agent), admin

**Backup owner**
Who gets a question or gate when its owner doesn't answer before the timeout, or when a touched
decision domain has no owner: the owner's named backup, else the project approver. Never an
auto-accept.
_Avoid_: delegate, fallback approver

**Decision domain**
An area of a project (product, architecture, security…) mapped to an owner in `.factory/`. Triage
tags the domains a work item touches; planning questions and approvals are routed to that owner.
_Avoid_: area, topic, scope

## Work

**Work item**
The unit of work the factory tracks from intake to done: a requester, a source, a stage, a living
spec and acceptance criteria, runs and a review packet. Each one is driven by one Workflow.
_Avoid_: task, ticket, job (a job is one stage's assignment to a runner), issue (the GitHub thing)

**Stage**
A step in a work item's pipeline: triage, planning/spec, implement, verify, and so on. Pipelines
are configurable per project.
_Avoid_: phase, step (in code), stage spec (the build unit in `docs/specs/` is a **spec**)

**Gate**
A point where the Workflow stops until a decision is made: spec approval, a question, merge,
deploy. Gates are enforced in code. A gate decision is recorded in the audit journal. The policy
step inside `invoke()` that answers allow / review / deny is "the gate check"; a `review` answer
opens a gate. `factory/verify` is a required **check**, not a gate.
_Avoid_: checkpoint, approval step, gatekeeper (now **connector**), "factory gate" (say
`factory/verify` or the merge gate)

**Foreman**
The LLM that picks a work item's route within the gates. It cannot open or skip a gate the autonomy
policy requires. Its decisions (ADR 0005):
- **size** (`small | medium | large`), and so whether the spec stage is skipped: **binding**,
  logged with its reason;
- **domains touched**: **binding** for routing questions and approvals (during build it may only
  add domains);
- **route** (next stage, capabilities, whether to ask a question): **advisory**; the Workflow and
  scheduler accept it only within the pipeline and `.factory/` limits;
- **retry or escalate** after a failed run: **binding** up to the retry limit; escalating to a
  person is always allowed.
_Avoid_: coordinator, orchestrator, manager agent

**Planning**
The built-in stage that turns a request into a living spec: questions with defaults and
recommendations, mockups and designs. Used at triage, spec, agent questions, design review and
greenfield kickoff.
_Avoid_: interview (for the stage; that is the kim tool it is modelled on), grooming

**Question**
The one planning object (ADR 0042): a decision someone must make on a work item, with its decision
domain, assignee, default, recommendation, whether it blocks, visibility, answer and status.
Questions in the security & privacy domain, and irreversible ones, are never bulk-accepted.
_Avoid_: prompt, ask, query, ticket

**Assumption**
A reversible choice the agent records on the living spec instead of asking a question. Visible and
can be overturned.
_Avoid_: default (that is a question's suggested answer), guess

**Interview session**
A **view** over a work item's questions for one audience: planning (the owners, full view),
clarification (a guest sees only their questions and shared mockups), design review, or decision
(one question). It holds no state beyond its filter and audience. Owners delegate questions, never
the whole feature.
_Avoid_: planning session (old name), meeting, thread

**Living spec**
A work item's spec, updated as planning answers arrive, with its acceptance criteria. Written in the
spec format (Goal / Scope / Out of scope / Acceptance criteria). Committed to `docs/specs/NN-*.md`
on the work item's branch when it is approved, never straight to main.
_Avoid_: PRD, design doc, plan

**Acceptance criterion**
One checkable statement in a spec. The verifier checks each one and attaches evidence to the review
packet. The criteria together are the definition of done.
_Avoid_: requirement, test case, AC (in UI copy)

**Holdout test**
An acceptance test written by the verify side from the approved criteria and never shown to the
implementing run (ADR 0034). Its results are a section of the review packet.
_Avoid_: hidden test, eval

**Review packet**
What a person reviews at a gate: a verdict row, what changed, criteria with evidence, reviewer
notes, screenshots, risk flags, the diff and a preview link. Sections are set per project in
`.factory/` (`reviewPacket.sections`). It also backs the `factory/verify` check. The packet in the
app **is the merge gate** (ADR 0041); it links to the GitHub PR for line comments.
_Avoid_: PR summary, report

**Lease**
A time-limited claim on a work item by a session or runner, kept alive by heartbeat. While a local
session holds the lease, cloud runs back off.
_Avoid_: lock, checkout

**Fencing token**
A number that only increases per work item, returned by every `lease.claim`. Every write from the
lease holder carries it, and a write with a stale token is refused, so a holder whose lease was
taken over can no longer change anything (ADR 0035).
_Avoid_: lease id, version, epoch (the kill switch has one)

**Job**
One stage's assignment to a runner: triage, spec, build or verify, with the model role, prompt,
context and required capabilities. Queued until a runner claims it; a retry is a new job.
_Avoid_: task, run (a run is one execution of a job)

**Run**
One execution of a stage job on a runner. Each run pushes to its own branch
(`factory/<id>-<slug>-run-<n>`); only the control plane moves the work item's branch
(`factory/<id>-<slug>`) forward to an accepted run.
_Avoid_: job (the assignment), session (the harness's), attempt

**Pending action**
A gate waiting on a person: an operation the gate check answered `review` for, stored with its
input until someone decides it (ADR 0007). Its kind says which inbox card it is: `spec`, `merge` or
`approval`. Approving re-runs the operation once, as the original actor.
_Avoid_: approval request, ticket, task

**Factory incident**
A work item the factory opens on itself when a PR is sent back or a run fails or stalls: it proposes
a fix to `.factory/` plus a regression case in `evals/regressions/`, and goes through the normal
gates. It carries a **root-cause class** (`missing-check`, `prompt-or-skill`, `missing-context`,
`policy`, `runner`, `confinement`, `unknown`) saying which part of `.factory/` to change. An
incident's own failures open no further incidents. A fix that only adds checks and regression cases
may auto-merge where the project opts in (ADR 0230).
_Avoid_: bug, postmortem, issue

**Check (`.factory/checks/`)**
A project's own static rule: files it applies to, and patterns that must or mustn't appear. CI runs
every check over the repo (the evals suite), so `factory/verify` can't pass while one fails. The
cheapest incident fix. Not to be confused with a GitHub **check run** (`ci`, `factory/verify`).
_Avoid_: lint rule, guard

**Regression case**
`evals/regressions/<incident>.json`: the input that slipped through an incident and what the
incident's check must say about it. CI runs them; never edited or deleted.
_Avoid_: test case, fixture

## Execution

**Runner**
Something that executes jobs: a machine or service with capacity and capabilities, owned by a user.
Owner-only by default; the owner shares it through an explicit allowlist of orgs, factories or
projects (ADR 0038). It can report "rate-limited until T". Example: the Orca runner on the Mac mini,
capacity 4.
_Avoid_: worker (a Cloudflare Worker), agent, executor, host (the runner host is the daemon)

**Runner adapter**
The code that implements the runner contract for one kind of runner: `runner-orca` (v1),
`runner-local`, `runner-codex-cloud`. The core only knows the contract.
_Avoid_: driver, plugin, integration

**Runner host**
The generic daemon (`local/runner-host`) on a runner's machine. It connects outbound over the
signed channel and loads runner adapters.
_Avoid_: agent, daemon (in copy), runner (the host is not the runner)

**Capability**
Something a runner or harness declares it can do. Jobs ask for capabilities; `.factory/` can
restrict them. The known ones:
- `browser`: can drive a browser for screenshots and visual evidence;
- `ui-takeover`: a person can take the session over in the runner's UI;
- `auto-register`: sessions the runner launches attach to their work item by themselves;
- `own-hardware`: runs on a machine its owner controls (for client repos);
- `hooks`: the harness runs session hooks (inject the live work item, block writes until claimed,
  heartbeat);
- `headless`: runs a session with no terminal or UI attached (e.g. `claude -p`).
_Avoid_: feature, permission (that is the operation's), skill

**Harness**
An agent CLI the runner drives for a job, behind an adapter with a capability manifest. v1 is
Claude Code (`harness-claude`).
_Avoid_: model (code asks for a model role), agent (too broad), tool

**Engine**
The cloud Worker (`apps/engine`, `sf-engine`) that runs Workflows, queues and cron. Named so it is
not confused with runners.
_Avoid_: runner (the CRM's name for this Worker), backend

## Policy and config

**Autonomy policy**
How much a project's agents may do without a person: the gate check's answer for each actor × risk
class, the spec threshold, timeouts, WIP limit. Shipped ones are Cautious, Balanced and Autonomous
in the global factory repo; a project's `.factory/` picks one and can override it. Read only from
the default branch (ADR 0036).
_Avoid_: preset (old name), mode, level, profile

**Project template**
A shipped bundle of repo practice (`AGENTS.md`, `CONTEXT.md`, ADRs, specs, …) installed into a
project, from `minimal` to `product` (ADR 0026).
_Avoid_: preset (old name), scaffold, boilerplate

**Floor**
The global policy an autonomy policy or project override can only tighten, never loosen. Merge,
deploy and self-modify always need a person regardless (the one pre-approvable merge is
`check-merge`, an incident's check-only fix, ADR 0230). A client org has its own floor.
_Avoid_: baseline, minimum policy, guardrails

**Evidence policy**
Per project in `.factory/`: which evidence (transcripts, logs, screenshots, diff) may leave the
runner and be stored by the control plane, and for how long (ADR 0039).
_Avoid_: retention policy, data policy

**WIP limit**
How many items may wait at human gates for a project or approver. At the limit the scheduler starts
no new builds there: **backpressure** (ADR 0040).
_Avoid_: queue size, concurrency (that is a runner's capacity)

**Kill switch**
A human-only switch per org and per project that pauses its work items at their next step, stops
their runs and releases their slots (ADR 0044).
_Avoid_: pause all, emergency stop

## Mechanics

**Operation**
A factory verb defined once in the registry with schemas, description, permission and risk class.
The dashboard, MCP and the runner channel are generated from it.
_Avoid_: endpoint, action (except outbound actions), command, API call

**Connector**
The boundary to an outside system (`packages/connector-*`). Inbound, it verifies and deduplicates
webhooks into typed events and maps them to operations (the GitHub connector: `verify.refresh`,
`push.observe`, `github.installation`). Outbound, it performs journaled actions
(comments, PRs) so agents never hold standing tokens. The GitHub connector mints per-job repo
tokens (ADR 0033).
_Avoid_: gatekeeper (old name), integration, webhook handler

**Job token**
A short-lived GitHub App token scoped to one repo, minted for one job and pushed with only to the
run's branch. The harness has no other git or cloud credentials (ADR 0033).
_Avoid_: PAT, deploy key, user token

**Audit journal**
The append-only record of every operation: actor, origin, gate decision, diff. Metrics are SQL
views over it.
_Avoid_: log, history, event store, analytics

**Outbox**
Notification events written in the same D1 batch as the state change they announce, delivered
afterwards, so a notification is never lost.
_Avoid_: queue (Cloudflare Queues are a transport), notifications table
