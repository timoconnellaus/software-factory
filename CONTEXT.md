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
A body of work inside a factory (a product, a launch, Marketing): org → project → work item → run.
It has one config (versions in the app, ADR 0370) and zero or more repositories (ADR 0490).
_Avoid_: repo (a project is not a repository), app

**Repository**
A GitHub repository of a project, reached through the org's GitHub App installation: owner, name,
default branch. A GitHub repository is in at most one project. A work item uses one repository,
chosen when it is created (the project's only one by default) and fixed once its pipeline starts.
_Avoid_: project (when you mean the repo), repo record

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

**Backlog, ready, queued**
The states a work item has before its pipeline starts (ADR 0491). **Backlog**: captured (title,
notes, project, priority); nothing runs. **Ready**: shaped (size, acceptance criteria). **Queued**:
released to the factory, waiting for a slot. No Workflow exists in them; creating an item leaves it
in the backlog unless the caller releases it in the same step (New work, `sf new`).
_Avoid_: draft, todo, inbox (the inbox is what waits on a person)

**Shaping, delivery**
The two phases of a workflow's stages, with release between them (ADR 0493). **Shaping** stages
need a person, hold no build slot and don't count as active; with today's engine they are triage and
interview planning (the spec stage and its gate). Triage is the one shaping stage that needs no person
(spec 52, Q1). **Delivery** is everything from build on. A person
can shape an item before releasing it (`workItem.shape`; its status is `shaping`, then `ready`);
small items are released from the backlog and shape inside delivery.
_Avoid_: planning state (planning is one stage type), pre-work

**Release**
Handing a backlog or ready item to the factory (`workItem.release`): it becomes queued. A person may
always release; an agent, intake or chat only where the project's config sets `release.agents`.
_Avoid_: submit, start, approve

**Pull**
The factory starting the next queued item of a project while its active items (running, waiting,
paused) are under the config's `activeLimit`: by priority, then rank, then release time, skipping
items whose **waits for** items aren't done. The pull pins the config version and the project's
workflow (ADR 0491, 0492).
_Avoid_: dispatch, schedule (the scheduler places jobs on runners)

**Waits for**
A link from one work item to another in the same org, any project: the first isn't pulled until the
second is done (a launch post waits for its feature). No cycles.
_Avoid_: depends on, blocked by (that is the read: what still holds it)

**Attached PR**
A pull request opened outside the factory (by a local session or a person) and attached to a work
item of kind `attached` (`workItem.attachPr`, the `/attach` page that its failing `factory/verify`
check links to, or New work's list of open PRs). Triage drafts criteria from the PR. Spec and build
are skipped, and the factory never pushes to its branch. Verify runs on the PR's own head and a pass
opens the merge gate. A failure or send-back waits for a push, a push withdraws a pending merge
gate, and closing the PR cancels the item (spec 05, ADR 0290). A person's push to a factory-built item's
branch, from verify on, also withdraws its merge gate and verifies the new head without a build
(Workflow v14, ADR 0587).
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
app **is the merge gate** (ADR 0041); it links to the GitHub PR for line comments. Its **Tests
intact** section is always shown (ADR 0500).
_Avoid_: PR summary, report

**Factory check**
A command the project declares in its config (`checks`, plus any its workflow adds) that the
**runner host** runs itself on a clean copy of the head SHA after a build (an attached PR: before its
review), under the job's isolation: a check container, or the host's OS sandbox with the harness's
floor. With neither it reports the check **not run**, which fails (ADR 0501). A check that fails on a
runner limit (its memory, as the Docker daemon recorded it, or its disk, as the host measured it;
never from anything the check prints) is a failed check with the limit named: the code under check
may be the cause, so it is no "not run", but a fix round can't raise the limit, so a person decides.
Its exit code,
duration and redacted log tail are stored against that SHA; the verdict needs every declared check
to pass there (from Workflow v8). A failure goes back into the same build session first, then to a
person. Only a non-static check proves a criterion.
_Avoid_: runner check (the agent's own report), CI

**Proven**
An acceptance criterion is **Proven** when a check the approved spec links it to (a factory check or
a CI check run, `[checks: …]` on the criterion) passed on the head SHA. A check triage (an agent)
tied it to that passed is never Proven: it is "passed the check triage named", counted apart. A
setup or static check never proves. Otherwise it is **Not proven**, and the reviewer's reasoning, and any checks the reviewer linked, are shown as
opinion; `[checks: none]` is **not covered by a check**. With no checks set up at all, the gate says
nothing can be proven instead of a count (ADR 0501, [`docs/checks.md`](docs/checks.md)).
_Avoid_: met (the reviewer's judgement)

**Tests intact**
The factory's own check, in code, that a diff doesn't weaken the tests the build is judged by:
deleted, removed, skipped or commented-out tests, new lint or type suppressions, lowered thresholds
and edits to gate files (`.factory/`, CI workflows, test and lint config), read from GitHub's diff at
the head SHA (ADR 0500). A **finding** is for a person: it never fails the verdict, no agent judges
it, and it blocks an auto-approved merge (ADR 0515). Findings belong to one SHA's review packet.
_Avoid_: test tampering check, reviewer finding

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
decision from the desktop (ADR 0391). On a phone device the key is a biometric-bound Keystore
key and the person gives a fingerprint (ADR 0541). Which operations take one on which device, and
which are one tap, is `deviceDecidable()`, pinned by a test.
_Avoid_: 2FA, confirmation

**Phone device** (spec 60)
An Android phone running the phone app, registered by scanning a pairing offer's QR code or by a
GitHub sign-in in the phone's browser (ADR 0541). It holds a per-use, fingerprint-bound Keystore
key whose attestation the engine checked, plus a `mobile` token (`sfm_`) for the `mobile` surface.
Plan approvals, merges and policy approvals take a fingerprint; ordinary answers are one tap. A
phone whose boot isn't verified or whose bootloader is unlocked registers with `key_storage =
software` and can't approve. Stored in the same table as desktop devices, with `platform =
android`; listed and revoked with `device.list` and `device.revoke`.
_Avoid_: mobile client, handset

**Pairing offer** (spec 60)
A one-use, five-minute QR code (with a typed fallback) that a signed-in person shows on the desktop
or website to add a phone (`mobile.pairOffer`). Showing it is the approval (ADR 0541); on the
desktop it takes Touch ID. Five wrong typed codes close it.

**Config proposal** (proposed, spec 60)
A config change drafted by chat or a person that changes nothing until a human approver approves it
with `config.approve`, whose proof binds the base version and the proposal's digest (ADR 0543).
_Avoid_: draft policy

**Merge queue**
A project's approved merges, waiting to land one at a time (ADR 0330). The **head** (the oldest
open entry) is brought up to date with the default branch by GitHub's update-branch, CI runs on
it once, and it merges; then the next head goes. The approval carries over that clean update. A
conflict or red CI at the head sends the item back to build. From Workflow v11 the babysitter's deliverer runs it per
repository, and the queue is its delivery table (spec 53).
_Avoid_: merge train, landing queue

**Babysitter** (spec 53)
What delivers approved work in one repository, from approval to Done: the merge, `main` staying
green and, later, the deploy (ADR 0580). Two halves: the **deliverer**, engine code with no model
(a reconcile pass per repository woken by GitHub's events and the minute cron), and the **`babysit`
job**, a factory job the deliverer starts only for judgement (a conflict, a failed check, a red
`main`; ADR 0583). Not a routine, not a schedule, not a person.
_Avoid_: merge bot, release manager, routine

**Delivery** (spec 53)
A work item's life after its merge is approved: waiting to merge, merging, **held**, merged (later
deployed). An **approval** says "this head may merge"; it survives a clean merge of `main` whose
**change digest** (the PR's diff against its merge base, read by the engine from GitHub) is unchanged,
and is withdrawn by any other new commit (ADR 0582).
_Avoid_: landing (fine in prose for the merge itself), shipping

**Main health, red episode** (spec 53)
Whether a repository's default branch head is `green`, `red` or `pending` by its required checks. A
**red episode** runs from the first red head after a green one to the next green; its **suspects** are
the landings since the last green SHA. While one is open the line stops: only **repairs** (a fix the
`babysit` job wrote, or a revert the engine made) merge, and every other approved item is **held**
(ADR 0581, 0584).
_Avoid_: broken build, main-red issue (patientos's claim; here the episode is the claim)

**Suspect, culprit** (spec 53)
An episode's suspects are the factory's landings since main was last green. Its culprit is the
one that turned it red: proven in code only when there is one landing and its merge commit is the
first red head, otherwise named by a person (`mainRed.attribute`). Never a guess (ADR 0621).

**Known flake** (spec 53)
A check, or a test in one, that failed and then passed on a rerun of the same SHA, recorded in the
repository's flake list (`core_flakes`). A failed check is rerun at most once per SHA (ADR 0583);
a check that flakes three times in 14 days gets a backlog item to fix it (decision 3).
_Avoid_: flaky test (as a label you add by hand)

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
incident's own failures open no further incidents. Its fix merges with no person only under
**dark factory mode**, like any change (ADR 0515; the check-only exception of ADR 0230 is superseded).
One kind is a record only, with no work item: an **archive incident**, when a run's archived log
lost an object in the archive bucket. No agent can bring it back, so it is listed on the desktop's
Checks and incidents page until a person resolves it (`incident.resolve`).
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
runner on the Mac mini, 2 heavy and 6 light. Under load it **pauses** pools (heavy first, then light;
ADR 0552) and says why on its heartbeat (`capacity.paused`, "runner busy: load").
_Avoid_: worker (a Cloudflare Worker), agent, executor, host (the runner host is the daemon)

**Runner adapter**
The code that implements the runner contract for one kind of runner: `runner-local` (git worktree +
tmux on the runner's machine, ADR 0380; it replaced the first adapter, `runner-orca`), later dev
boxes, sandboxes and `runner-codex-cloud`. The core only knows the contract.
_Avoid_: driver, plugin, integration

**Runner code**
What a runner host runs from its own checkout: `local/runner-host`, `packages/runner-*`,
`packages/harness-*` and their workspace dependencies. The **desired version** a heartbeat hands out
is the last commit on `main` that changed it (`RUNNER_SHA`, computed by the deploy), not every
deployed commit; a runner at or ahead of it is current (ADR 0520). A runner behind it keeps claiming
and updates at its first idle heartbeat (light jobs only after 30 minutes pending, nothing after 60).
_Avoid_: runner version (ambiguous with the compat level)

**Runner compat level**
`RUNNER_COMPAT` in `packages/runner-contract`: a number bumped by hand in the PR that makes a change
an older runner can't follow. The engine sends its own as `minRunnerCompat`; a runner below it claims
nothing until it has updated, and the engine sends no job to a runner that reported a lower one
(ADR 0520). Everything short of that follows the compatibility rule:
optional new fields, growing enums, new kinds of job behind a capability.
_Avoid_: contract version (`CONTRACT_VERSION`, which stays fixed)

**Job session**
The live harness for one job: under runner-local, Claude Code in the tmux session `sf-<jobId>` on
the factory's own tmux socket (`tmux -L software-factory`), in the job's worktree. Its status comes
from the harness's status hook (`<runDir>/status.jsonl`), not the screen (ADR 0380). What the agent
says comes from its transcript, as `message` events. People watch it on the work item page's
**Live** tab (spec 31). On a container runner, the tmux session runs the job's container, and
Claude runs inside it (ADR 0430). In a runner's **stream-json** session mode it is instead Claude
Code headless as a child process of the runner host, a two-way JSON stream (see Session mode).
_Avoid_: terminal (the session may have no terminal attached), pane

**Session mode**
How a runner runs its job sessions (ADR 0450), set per runner in `runner.json` `session`: `tmux`
(the default: Claude Code's TUI in tmux; takeover by `tmux attach`) or `stream-json` (Claude Code
headless, `claude -p --input-format stream-json --output-format stream-json`: the prompt pointer
and steers go in as JSON user messages, its events come from the structured output, and takeover is
by `claude --resume`). Both run the harness's launch script and are verified the same way (ADR
0270). On the wire a session's mode is `terminal` or `stream` (`session.started`), and a runner in
stream mode declares `chat`.
_Avoid_: headless mode (`headless` is a capability), chat mode

**Chat view**
The Live tab's view of a stream-json run (spec 37): the agent's text as Markdown, each tool call
with its input and output, a line per turn with its tokens and time, and the owner's messages, with
a composer and **Take over in a terminal** for the runner's owner. Not the planning chat.
_Avoid_: chat (alone: that is planning's), transcript (the terminal run's view)

**Takeover by resume**
Handing a stream-json run to a person (ADR 0450): `run.takeover` (the runner's owner only) asks the
host to stop the session cleanly, and the run then shows the exact `claude --resume <session-id>`
command (its worktree, settings, mode and model) to run on that machine. The job keeps its worktree
and lease and follows the resumed session through the status hook; quitting it hands the run back.
_Avoid_: attach (that is tmux), take over (alone: the lease takeover of ADR 0021 cancels the run)

**Steer**
A person's message into a live job session, sent from the Live tab with `run.steer` (ADR 0400) and
typed into the session as if at its terminal (a stream-json session gets it as a JSON user message,
ADR 0450). Only the owner of the run's runner may steer (it runs
on their machine with their model credential); others watch read-only. Every steer is journalled;
the runner host takes it over a held `steer` call on the signed channel, at most once.
_Avoid_: chat (planning has its own chat), prompt (the job's prompt is set at launch), command

**Web terminal**
A running job's real terminal in the browser: the **Web terminal** view on the Live tab (spec 35,
ADR 0440), xterm.js over a WebSocket to the job's **terminal relay**. Opening it is an operation,
`run.terminal.attach`, which records who attached, when, and the mode: `type` for the owner of the
run's runner, `watch` (read-only) for everyone else in the org. The relay enforces the mode. It
shows the visible screen, not scrollback.
_Avoid_: console, shell, remote desktop

**Terminal relay**
The `TerminalRelay` Durable Object in sf-engine, one per job (ADR 0440). The runner host connects to
it outbound with a one-use ticket it got from the signed channel's held `terminal` call, and viewers
connect through sf-app. It forwards the host's output to every viewer and only the runner owner's
keys and size to the host, and tells the host to stop when the last viewer leaves.
_Avoid_: proxy, tunnel (nothing listens on the host)

**Runner host**
The generic daemon (`local/runner-host`, command `sf-runner`) on a runner's machine. It connects
outbound over the signed channel, loads runner adapters, fetches into the checkout the machine
already has for each repo (found under the `checkouts` dirs in `runner.json` by canonical remote
identity; its own clone only when there is none, ADR 0260), and is the only thing
that pushes: the run branch, with the job token (ADR 0250). Before a build it merges the project's
default branch into the run branch, leaving any conflict for the session to resolve (ADR 0320).
It runs on the owner's Macs as a launchd LaunchAgent and on Linux machines they own as a systemd
user service, always as the owner (ADR 0420).
It keeps its own code on the commit the engine was deployed from, updating itself when idle
(ADR 0360).
_Avoid_: agent, daemon (in copy), runner (the host is not the runner)

**Claude account** (on a host)
A Claude subscription or key a runner host runs Claude Code with (ADR 0410): a **login** (its own
Claude config dir, used as `CLAUDE_CONFIG_DIR`) or a **token** (a `claude setup-token` OAuth token or
an API key in a 0600 file), plus `default`, whatever `claude` uses with no account set. Added and
removed only on the host (`sf-runner account`). One is **active**: a job takes it when its workspace
is prepared and keeps it. The owner switches it by hand, on the host or from Setup
(`runner.account.use`, which sends only the name). The factory sees names, never credentials.
_Avoid_: profile (Orca's word), login (only one kind), key (only one kind)

**Isolation**
How a runner confines a job's harness, set per runner in `runner.json` (ADR 0430):
- `sandbox`, the default: a git worktree with Claude Code's OS sandbox (ADR 0270);
- `container`: a Docker container per job. It mounts only the **job repo** (a new repo per job, with
  only the start point's history and the default branch), a fresh home and temp dirs. Egress goes
  only through the job's **egress proxy** (the stage's allowed hosts and the model API). Every stage
  runs `bypassPermissions`. The container gets the job's Claude account as its token, so it needs a
  token account (or `default` with a token in `runner.json`). A login account can't be used.
- `sprites`: a fresh **sprite** (a Sprites cloud sandbox, Fly.io) per job, made by the runner host
  with the owner's Sprites token (ADR 0480). The job repo and the run's files are copied in; egress
  is Sprites' network policy set to the same allowlist, ending in a deny-all; the job's tmux pane on the host is bridged
  to the sprite's terminal; the result comes back as a git bundle and the host pushes. The factory
  never sees the Sprites token or the Claude token; the sprite never sees the job token.
_Avoid_: sandbox (for the container or the sprite: the sandbox is Claude's own; say "cloud
sandbox" or "sprite")

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
  outside the git tree (ADR 0310);
- `container-isolation`: each job's harness runs in its own container (ADR 0430); planning sessions
  still run on the host;
- `cloud-sandbox`: each job runs in a cloud sandbox the runner host makes for it (a sprite, ADR
  0480), not on the host's own hardware. Such a runner declares neither `own-hardware` nor
  `container-isolation` (its egress is per host, not per port, and has no request log);
- `steer`: a person can message the live session from the dashboard (a **steer**, ADR 0400);
- `chat`: sessions run as a structured stream (the stream-json **session mode**): the dashboard
  shows them in the **Chat view** and the owner can take one over by resume (ADR 0450);
- `terminal`: the live session's terminal can be bridged to the dashboard's **web terminal**
  (runner-local: a tmux control-mode client, ADR 0440).
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

**Stage type**, **workflow template**, **stage template** (spec 52, being built)
A stage type is built-in code with a fixed contract (what it runs, produces and needs, its evidence,
screen, gate and reversibility); a workflow will be an org-level ordered list of stages, each an
instance of a stage type, split into **shaping** stages (before release) and **delivery** stages.
Templates are ready-made workflows (Software, Marketing) or stage types with default settings
(ADR 0510). Org admins edit an org workflow and approve its loosenings; a project may override only a
short list of settings. Attached PRs and incidents run **built-in workflows** people can see and
tighten, not loosen. Small stages (`agent-check`, `decision`) show inside the stage they belong to.

**Skill** (designed, spec 52, not built)
How the team does one thing, written once (instructions plus files), versioned and owned by the
org, attached to an agent, a stage, or built into a stage type. The factory may propose an edit;
only a person accepts one (ADR 0513). Org skills reach the reviewer only by extending its built-in
skills, as a policy change.
_Avoid_: playbook, recipe

**Autopilot** (designed, spec 52, not built)
A trigger (schedule or event), an agent, its skills, an instruction and an output target: work the
factory starts on its own. It files through the backlog, never merges or deploys (ADR 0514). Each run
is a work item of kind `autopilot`, hidden from the Work lists and shown as run history on the
autopilot's page, limited per autopilot by a time limit, an output cap and a daily run cap.
_Avoid_: cron job, bot

**Agent** (config)
A harness-neutral profile: model role and tier, instructions, abstract permissions, capabilities.
The runner that takes the job resolves the model (ADR 0372).
_Avoid_: droid, persona, bot

**Practice change / policy change**
A practice change alters *how* work is done (instructions, tiers, advisory steps); the factory may
apply it itself as a **trial**, except agent instructions and skills, which it only proposes and a
person accepts (spec 52, Q17). A policy change alters *what's allowed* and always goes to a person
(ADR 0373).

**Trial**
A practice change applied to the next N items of one workflow, then promoted or rolled back on
outcomes (verify pass rate, send-backs, gate edits), then cost and time.

**Adjudicator**
An agent that records the gate decision it would make in shadow mode, and approves a gate kind only
after earning ≥95% precision; never rejects, never deploy or self-modify. On merge its earned approval
is one condition of **dark factory mode**, never enough alone (ADR 0374, 0515).

**Dark factory mode** (`autoApprove`, designed, spec 52, ADR 0515)
A setting on the workflow's merge gate (later its deploy gate), off by default; never a per-project
override (a project that wants it runs a workflow that has it on). With it on, the merge gate is approved with no person (the babysitter then lands it, as for a
person's approval) only when every
check passed and every criterion is proven by a check that ran, tests are intact, the adjudicator
approved and has earned it on this project, the change is inside the size and path limits, and its
risk is low (no migrations, auth, billing or policy files). Turning it on is a loosening an org admin
approves; on an incident, a revert or red CI after its merge it puts a **hold** on that project
(not on the shared workflow), which an org admin lifts (a loosening, approved by an org admin). Changes to the
factory itself always need a person.
_Avoid_: auto-merge (that was ADR 0230's narrow exception), YOLO mode

**Project template**
A shipped bundle of repo practice (`AGENTS.md`, `CONTEXT.md`, ADRs, specs, …) installed into a
project, from `minimal` to `product` (ADR 0026).
_Avoid_: preset (old name), scaffold, boilerplate

**Floor**
The global policy an autonomy policy or project override can only tighten, never loosen. Merge,
self-modify always needs a person regardless; merge and deploy need one unless dark factory mode
holds (ADR 0515, which supersedes ADR 0230's `check-merge`). A client org has its own floor.
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
The append-only record of every operation that changed something: actor, origin, gate decision,
diff. Machine-frequency calls (heartbeats, empty claims, held waits, presence, log batches) are
recorded only when they change state, and a runner's input is kept as a digest (ADR 0590). Metrics
are SQL views over it. **Machine rows** (a runner's, the scheduler's, an intake's or the foreman's
routine calls, allowed and successful, on a fixed list of operations) move to the **audit archive**
in R2 after 90 days as a hash chain, read back by the timeline and checked by `audit.verify`;
everything else stays in D1 forever (ADR 0591).
_Avoid_: log, history, event store, analytics

**Outbox**
Notification events written in the same D1 batch as the state change they announce, delivered
afterwards, so a notification is never lost.
_Avoid_: queue (Cloudflare Queues are a transport), notifications table
