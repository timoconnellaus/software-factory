# Context: domain glossary

Use these words exactly, in code, docs and UI copy. Add to this file when a new term earns its place.

Renamed 2026-11-11 ([review decisions](docs/reviews/2026-11-11-review-decisions.md)): gatekeeper →
**connector**; preset → **autonomy policy** or **project template**; `docs/stages/` → `docs/specs/`;
planning session → **interview session**, now a view over **questions** (and since ADR 0300, **planning session** means the agent's session on a runner).

## The organisation

**Org**
A group of users with members, roles and invitations (Better Auth organization plugin). Every user
gets a **Personal** org. An org owns factories and its GitHub App installations; runners are shared into
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
spec and acceptance criteria, runs and a review packet. Each one is driven by one Workflow. Its
**kind** is `change` (work for the factory to build), `incident` (a factory incident) or `attached`
(an attached PR).
_Avoid_: task, ticket, job (a job is one stage's assignment to a runner), issue (the GitHub thing)

**Attached PR**
A pull request opened outside the factory (by a local session or a person) and attached to a work
item of kind `attached` (`workItem.attachPr`, the `/attach` page that its failing `factory/verify`
check links to, or New work's list of open PRs). Triage drafts criteria from the PR. Spec and build
are skipped, and the factory never pushes to its branch. Verify runs on the PR's own head and a pass
opens the merge gate. A failure or send-back waits for a push, a push withdraws a pending merge
gate, and closing the PR cancels the item (spec 05, ADR 0290).
_Avoid_: imported PR, adopted PR, external work item

**Attachment**
A file a person added to a work item (a screenshot, a log, a mockup), by picker, drag-and-drop or
pasting from the clipboard. Its metadata is a D1 row and its bytes are in R2; the item's runs can
read it over the job channel. Its name and content are untrusted data, never instructions (ADR 0310).
_Avoid_: artifact (that is what a run produces), upload, file (in copy, when you mean this)

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
recommendations, chat, mockups and designs, with a planning agent that stays with the work item
(ADR 0300). Used at triage, spec, agent questions, design review and greenfield kickoff.
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
_Avoid_: meeting, thread (before ADR 0300 this was also called a planning session; that name now
means the agent's session below)

**Planning session**
The planning agent's resumable session on a runner for one work item (ADR 0300). It manages the
questions and the living spec through operations, receives answers through hooks while it works, and
waits in its Stop hook when idle. It holds a **light slot**, yields only when the light pool is full,
and always resumes on the same runner unless a person moves it; a move rebuilds it from the
**planning record** (spec versions, questions, answers, chat, artifacts).
_Avoid_: interview, run (a planning session spans several jobs), chat

**Planning log**
Every answer, revised answer, chat message, presence change and agent change on a work item's
planning, in order (`core_planning_events`, ADR 0350). Its id is the **cursor**: a session's news is
the log after the last event it was given, minus its own changes.
_Avoid_: event stream, history

**Presence**
Who has a work item's Planning view open, from the app's heartbeat. The planning agent sees it in
its news; a session yields only after nobody has been there for 5 minutes (ADR 0301).
_Avoid_: online, attached (that is the session's state)

**Provenance tag**
The source of a statement in the living spec: `[Qn]`, `[request]`, `[repo]`, `[parent]` or
`[assumption]` (ADR 0302). Always visible at the spec gate.
_Avoid_: citation, footnote

**Coverage**
The checklist in a living spec of what planning has considered (scope, data & permissions, UX, edge
cases, non-functional, terminology, plus project categories), each clear, partial or not applicable.

**Spec critic**
A separate run that reviews a spec before its gate opens and leaves notes; advisory only (ADR 0302).

**Needs info**
A parked work item waiting on its requester: it failed the readiness pre-check or triage found it
not actionable (ADR 0304). Takes no WIP slot.

**Split**
A spec that creates child work items when approved, each with its own spec slice; depth 1
(ADR 0303).

**Spec drift**
Where a build departs from its approved spec's scope; a review-packet section (ADR 0306). Not the
ruleset **drift** of ADR 0280.
_Avoid_: drift (alone, in planning or verify copy)

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

**CLI token**
What `sf login` gets once a person approves its code in the app: acts as that person on the `cli`
surface, `read` (see work; for agent sessions) or `write` (also create, attach, cancel), for 30
days, revocable. It can never decide a gate: those operations are **browser-only** (ADR 0340).
_Avoid_: API key, PAT

**Desktop device**
A Mac running the desktop app, registered by a browser sign-in (ADR 0391): a Secure Enclave key
plus a desktop token. Its token acts as the person on the `desktop` surface, like a `write` CLI
token; it can decide a gate only with a **presence proof** (Touch ID signing that exact call).
Listed and revoked on the website.
_Avoid_: client, install

**Presence proof**
A one-time challenge, signed by a desktop device's Secure Enclave key after Touch ID, bound to one
operation and the digest of its input. The client door checks it; `invoke()` needs it for a gate
decision from the desktop (ADR 0391).
_Avoid_: 2FA, confirmation

**Merge queue**
A project's approved merges, waiting to land one at a time (ADR 0330). The **head** (the oldest
open entry) is brought up to date with the default branch by GitHub's update-branch, CI runs on
it once, and it merges; then the next head goes. The approval carries over that clean update. A
conflict or red CI at the head sends the item back to build.
_Avoid_: merge train, landing queue

**Default-branch ruleset**
The repository ruleset that guards a project's default branch: a PR, the CI checks and
`factory/verify` (pinned to the App, branch up to date), no force pushes, no deletion, **no bypass
actors**. The factory generates it as a file (`<repo>-default-branch.json`); a person imports it on
GitHub, because the App only reads repository settings. **Protection** is the factory's verdict on
it: `ok`, or `red` with what's missing; a red after an ok is **drift** (ADR 0280).
_Avoid_: branch protection (GitHub's older, classic mechanism), lock

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
A work item the factory opens on itself when a PR is sent back or a run fails or stalls (an
attached PR sent back at review opens none: the factory didn't build it): it proposes
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
projects (ADR 0038). It can report "rate-limited until T". Its capacity has two pools (ADR 0301):
**heavy** slots for build and verify, and **light** slots for planning and triage. Example: the local
runner on the Mac mini, 2 heavy and 6 light.
_Avoid_: worker (a Cloudflare Worker), agent, executor, host (the runner host is the daemon)

**Runner adapter**
The code that implements the runner contract for one kind of runner: `runner-local` (git worktree +
tmux on the runner's machine, ADR 0380; it replaced the first adapter, `runner-orca`), later dev
boxes, sandboxes and `runner-codex-cloud`. The core only knows the contract.
_Avoid_: driver, plugin, integration

**Job session**
The live harness for one job: under runner-local, Claude Code in the tmux session `sf-<jobId>` on
the factory's own tmux socket (`tmux -L software-factory`), in the job's worktree. Its status comes
from the harness's status hook (`<runDir>/status.jsonl`), not the screen (ADR 0380).
_Avoid_: terminal (the session may have no terminal attached), pane

**Runner host**
The generic daemon (`local/runner-host`, command `sf-runner`) on a runner's machine. It connects
outbound over the signed channel, loads runner adapters, fetches into the checkout the machine
already has for each repo (found under the `checkouts` dirs in `runner.json` by canonical remote
identity; its own clone only when there is none, ADR 0260), and is the only thing
that pushes: the run branch, with the job token (ADR 0250). Before a build it merges the project's
default branch into the run branch, leaving any conflict for the session to resolve (ADR 0320).
It keeps its own code on the commit the engine was deployed from, updating itself when idle
(ADR 0360).
_Avoid_: agent, daemon (in copy), runner (the host is not the runner)

**Capability**
Something a runner or harness declares it can do. Jobs ask for capabilities; `.factory/` can
restrict them. The known ones:
- `browser`: can drive a browser for screenshots and visual evidence;
- `ui-takeover`: a person can take the session over (runner-local: `tmux attach` on the host);
- `auto-register`: sessions the runner launches attach to their work item by themselves;
- `own-hardware`: runs on a machine its owner controls (for client repos);
- `hooks`: the harness runs session hooks (inject the live work item, block writes until claimed,
  heartbeat);
- `headless`: runs a session with no terminal or UI attached (e.g. `claude -p`);
- `work-item-attachments`: fetches the work item's attachments over the job channel into the run,
  outside the git tree (ADR 0310).
_Avoid_: feature, permission (that is the operation's), skill

**Harness**
An agent CLI the runner drives for a job, behind an adapter with a capability manifest. v1 is
Claude Code (`harness-claude`). The harness owns its launch command and checks the live process against it
before the job starts (ADR 0270); a difference is a `harness-config-mismatch`.
_Avoid_: model (code asks for a model role), agent (too broad), tool

**Engine**
The cloud Worker (`apps/engine`, `sf-engine`) that runs Workflows, queues and cron. Named so it is
not confused with runners.
_Avoid_: runner (the CRM's name for this Worker), backend

## Policy and config

**Autonomy policy**
How much a project's agents may do without a person: the gate check's answer for each actor × risk
class, the spec threshold, timeouts, WIP limit. Shipped ones are Cautious, Balanced and Autonomous
in code; a project's config version picks one and can override it (ADR 0370).
_Avoid_: preset (old name), mode, level, profile

**Config version**
One saved state of a project's config (policy, agents, workflows), kept as a row in D1 and written
only through `config.*` operations. A work item records the version it started under (ADR 0370).
Exported and imported as a `.factory/` bundle.
_Avoid_: policy file, settings PR, policy SHA (the old name)

**Impact summary**
The server's classification of a config change as loosening, tightening or neutral
(`policyImpact`). A loosening save is `self-modify` and waits for an approver.

**Workflow** (of a project)
A named preset that fills the fixed skeleton's three slots (after spec, before verify, after verify)
with steps. Triage picks one per work item. Workflows only add steps (ADR 0371).
_Avoid_: pipeline (the skeleton), stage list

**Step**
One entry in a workflow slot: a **work** step hands to an agent and is advisory; a **gate** step
hands to a person and is enforced.

**Agent** (config)
A harness-neutral profile: model role and tier, instructions, abstract permissions, capabilities.
The runner that takes the job resolves the model (ADR 0372).
_Avoid_: droid, persona, bot

**Practice change / policy change**
A practice change alters *how* work is done (instructions, tiers, advisory steps); the factory may
apply it itself as a **trial**. A policy change alters *what's allowed* and always goes to a person
(ADR 0373).

**Trial**
A practice change applied to the next N items of one workflow, then promoted or rolled back on
outcomes (verify pass rate, send-backs, gate edits), then cost and time.

**Adjudicator**
An agent that records the gate decision it would make in shadow mode, and approves a gate kind only
after earning ≥95% precision; never rejects, never merge, deploy or self-modify (ADR 0374).

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

**Installation**
One GitHub App installation on a GitHub account, recorded for one org (`core_github_installations`,
ADR 0055). Connected with **Connect GitHub** (GitHub's install flow and the app's Setup URL), kept
current by webhooks. People never see or type its id; a project is a repo an installation reaches.
_Avoid_: installation id (in anything a person reads), GitHub integration

**Device login**
How a runner connects (ADR 0056): `sf-runner login` shows a short code, a person approves it in the
app at `/runners/connect`, and the runner receives its key once. `pair --key-stdin` is the fallback.
_Avoid_: pairing (for the main path), registration code

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
