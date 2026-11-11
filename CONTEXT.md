# Context: domain glossary

Use these words exactly, in code, docs and UI copy. Add to this file when a new term earns its place.

## The organisation

**Org**
A group of users with members, roles and invitations (Better Auth organization plugin). Every user
gets a **Personal** org. An org owns factories, a GitHub App installation and shared runners.
_Avoid_: team (except the Team view in the UI), workspace, tenant, account (an account is a
signed-in session)

**Factory**
One configured pipeline inside an org: its presets, floor, runners and projects. A client gets its
own factory so its work and runners stay isolated. Also the product as a whole ("the factory").
_Avoid_: pipeline (for the whole thing), instance

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
are configurable per project. Also the build unit of this repo (`docs/stages/`), which the factory
writes in the same format.
_Avoid_: phase, step (in code)

**Gate**
A point where the Workflow stops until a decision is made: spec approval, a question, merge,
deploy. Gates are enforced in code. A gate decision is recorded in the audit journal.
_Avoid_: checkpoint, approval step

**Foreman**
The LLM that picks a work item's route within the gates (which stage next, which runner, retry or
escalate). It cannot open or skip a gate.
_Avoid_: coordinator, orchestrator, manager agent

**Planning**
The built-in stage that turns a request into a living spec: questions with defaults and
recommendations, mockups and designs. Used at triage, spec, agent questions, design review and
greenfield kickoff.
_Avoid_: interview (that is the kim tool it is modelled on), grooming

**Living spec**
A work item's spec, updated as planning answers arrive, with its acceptance criteria. Written in the
stage-spec format (Goal / Scope / Out of scope / Acceptance criteria).
_Avoid_: PRD, design doc, plan

**Acceptance criterion**
One checkable statement in a spec. The verifier checks each one and attaches evidence to the review
packet. The criteria together are the definition of done.
_Avoid_: requirement, test case, AC (in UI copy)

**Review packet**
What a person reviews at a gate: a verdict row, what changed, criteria with evidence, reviewer
notes, screenshots, risk flags, the diff and a preview link. Sections are set per project in
`.factory/` (`reviewPacket.sections`). It also backs the `factory/verify` check.
_Avoid_: PR summary, report

**Lease**
A time-limited claim on a work item by a session or runner, kept alive by heartbeat. While a local
session holds the lease, cloud runs back off.
_Avoid_: lock, checkout

## Execution

**Runner**
Something that executes jobs: a machine or service with capacity and capabilities, owned by a user
and shared into orgs or factories. Example: the Orca runner on the Mac mini, capacity 4.
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
Something a runner or harness declares it can do (`browser`, `ui-takeover`, `auto-register`,
`own-hardware`). Jobs ask for capabilities; `.factory/` can restrict them.
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

**Preset**
A named, shipped bundle of policy and repo practice (`minimal` → `product`; autonomy levels) in
the global factory repo. A project's `.factory/` picks one and can override it.
_Avoid_: template, profile, mode

**Floor**
The global policy a preset or project override can only tighten, never loosen. Merge, deploy and
self-modify always need a person regardless.
_Avoid_: baseline, minimum policy, guardrails

## Mechanics

**Operation**
A factory verb defined once in the registry with schemas, description, permission and risk class.
The dashboard, MCP and the runner channel are generated from it.
_Avoid_: endpoint, action (except outbound actions), command, API call

**Gatekeeper**
The boundary to an outside system. Inbound, it verifies and deduplicates webhooks into typed
events that become work items. Outbound, it performs journaled actions (comments, PRs) so agents
never hold raw tokens.
_Avoid_: integration, connector, webhook handler

**Audit journal**
The append-only record of every operation: actor, origin, gate decision, diff. Metrics are SQL
views over it.
_Avoid_: log, history, event store, analytics

**Outbox**
Notification events written in the same D1 batch as the state change they announce, delivered
afterwards, so a notification is never lost.
_Avoid_: queue (Cloudflare Queues are a transport), notifications table
