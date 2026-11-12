# Manage the factory's config in the UI, and let it improve itself

## Goal
Manage factory config in the app, and let the factory improve its own config (effectiveness **and** efficiency) without a person approving every change.

## Decisions
**Where config lives**
- **Config lives in the app** (D1, through operations), not in git. **Export/import** of a `.factory/` bundle for backup and templates. `.factory/checks/` stays in git (it's code CI runs). *Supersedes ADR 0009, 0036 and 0054; changes an AGENTS.md rule.*
- **Each save is a version.** New items use the latest version; a running item keeps its own. Per Fable 5, gates and harness permissions use the **stricter** of the pinned and current versions.
- **Editing:** any org member can edit. Edits are batched, with a diff + impact summary before saving. **Loosening** changes wait for an approver; you wanted that rule configurable per project, so it's tighten-only per project, with the minimum in the org floor (Fable 3). "Edit as JSON" is available as an escape hatch.

**Project Settings page** (`/projects/$id/settings`)
- Autonomy + overrides, timeouts + backup owner, WIP + default retry, approvers, review packet (show/hide + order), protection on main. Links to **Workflows** and **Agents**.

**Workflows**
- **Typed slots.** The skeleton is fixed in the engine: triage → spec → spec gate → build → verify → merge gate → merge queue. There are slots *after spec*, *before verify* and *after verify*. Named workflows (Ship a feature, Fix a bug, …) are presets that fill the slots. The default is empty slots, which equals today's v4.
- **Workflows only add steps.** The spec gate (by size), verify and merge come from size + policy in the engine. **Triage picks the workflow**; you can change it before build. It's logged as a binding foreman decision (ADR 0005 table). Because workflows only add steps, a wrong pick can't skip a gate.
- **Steps are `work`** (an agent; advisory: it can send work back or escalate) **or `gate`** (a person, enforced).
- Steps connect by *when done →*, *if it fails →* (retry, send back, ask a person), and conditions (size, domain). Gate steps go to a named person or `approvers`; on timeout they go to the backup owner.
- Core steps: you pick the agent and add instructions. Their prompts and the gates around them stay in code, and project text never reaches the verify or reviewer prompts (Fable 1).

**Agents and runners** (your point: jobs run on the requester's subscription, on Claude or Codex, or on shared cloud runners)
- **Decided:** an agent is **harness-neutral**: role + tier, instructions, abstract permissions, capabilities. The **runner** that takes the job (requester-first, ADR 0023) resolves harness + model from its owner's map; the harness adapter compiles the permissions. **Decided:** the project states model preferences per harness; the runner owner's map decides, and can cap what their subscription is used for.
- The improver changes **tiers and preferences**, not model ids.
- Runs record harness + model + runner, and comparisons are like for like (same harness/model class).
- **Cost:** on subscription runners, cost means rate-limit hits and time; tokens × price applies only to API-key runners.
- A runner owner can opt their runner out of trials.

**Self-improvement**
- **v1 loop:** every item records its config version, with metrics split by version; the factory proposes changes with evidence, and a person accepts them in the inbox; one-click rollback; compare a version with the one before. Evals replay comes later.
- **Decided: two tiers.**
  - **Practice:** the factory applies these itself as **trials with auto-rollback**. Covers agent/step instructions (never the verify or reviewer prompts); the tier/model for a work step's role, from what the runner offers; adding an advisory step, or removing one it added; new workflows (no gates removed); checks under `.factory/checks`; retry limit and timeouts within bounds; review packet order.
  - **Policy:** these go to a person through the inbox. Covers autonomy, overrides, approvers, gates, harness permissions that widen, the floor, verify/reviewer prompts and models, and the spec threshold.
  - So trials are in M3 after all; practice changes need them.
- **Guardrails:**
  - Lifecycle: candidate → trial → promoted or disabled on evidence.
  - Auto-rollback when worse.
  - A different model role critiques each change before it's applied.
  - A weekly cap, and one trial at a time per workflow.
  - A weekly digest, with one-click revert.
  - A per-project off switch.
- **The improver optimises:** outcomes (verify pass rate, send-backs, your edits at gates) must stay at least as good; within that, minimise cost and time.
- **Runs report:** tokens in/out per model (from the harness stream-json), wall-clock time per step, retries and send-backs, and an estimated cost (tokens × a price table per model).
- **Adjudicator: yes.** It watches your gate decisions in shadow mode, and only approves gates for you at ≥95% agreement. It never rejects, and never handles merge, deploy or self-modify (M4).
- **Gates ask for a short reason** on send-back, edit or reject (skippable). It's the improver's main signal.
- **Scope:** agent instructions, adding or removing steps, new workflows, thresholds, model role or harness per agent, and checks after incidents.

## Open
- None from the interview. The spec will settle the details: the config store schema, the slot schema, the trial assignment and the comparison statistics.

## Prior art
- Cursor Bugbot's learned rules (auto-promoted and auto-disabled on evidence) is the model for practice changes.
- Warp and Devin propose and a person approves.
- None of them lets the AI loosen permissions.

## Build: one spec, in milestones
1. **M1:** config store (versions, operations, validation before save, export/import), migrating from `policy.json`, and the Settings page.
2. **M2:** agents + workflow slots (`runV5`); today's pipeline becomes the default workflow.
3. **M3:** run usage reporting, plus the improver (proposals, trials, comparison, rollback, digest).
4. **M4:** the adjudicator, in shadow mode first.

## ADRs
- New: config in the app (supersedes 0009/0036/0054, amends AGENTS.md)
- New: typed workflow slots (amends 0005/0006)
- New: self-improvement tiers (amends 0008, AGENTS.md "self-modify always to a person")
