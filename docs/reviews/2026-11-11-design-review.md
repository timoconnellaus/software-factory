# Design review: 2026-11-11

An independent critical review by a Fable subagent. It covered the product plan, the UI plan, the architecture diagram, the research doc, the design-system README and 7 mockups. It did **not** read the ADRs (`docs/adr/0001–0032`, written in parallel) or competitors' docs. Comparisons and platform limits are from memory and need checking.

## Executive summary (ranked)
- **The central security claim doesn't hold as designed.** "Policy is enforced in code" is only true in the cloud. Runners act with the owner's own logged-in credentials, so an agent can push, merge or deploy outside the pipeline.
- **Scope went from personal to a multi-tenant team product in a day.** R1 now carries orgs, multi-session, shared runners, guests and decision domains before the core loop has run once.
- **Each review gets cheaper, but none are removed.** Merge always needs you. In the metrics mockup, human waits (1h12m spec, 2h40m merge) dwarf build time (24m).
- **Away-time, a named pain, is unaddressed through R4.** There's no push until a native app exists.
- **Verification is a closed loop.** The same system writes the spec, code, tests and evidence. A reviewer on "a different model" is only weakly independent when the harness is the same.
- **Prompt injection reaches a gate.** Triage reads untrusted intake text and decides whether the spec gate is skipped.
- **Cloudflare Workflows is a poor fit as the per-work-item state machine.** Items loop, pause, get taken over, and outlive deploys.
- **The real differentiators are buried** under undifferentiated control-plane work. They are governed local sessions and delegated planning questions.

## Top 10 changes
1. Mint per-job, repo-scoped GitHub App tokens. Remove the owner's git credentials from agent sessions, and disallow admin bypass.
2. Cut R1 to the plan's MVP. Defer multi-session, guests, domains, runner sharing, Codex Cloud and content.
3. Run a 20–30 ticket review-packet experiment (a script with `orca`, `claude -p` and `gh`) before building the control plane.
4. Add notifications with deep links in R1.
5. Make skipping the spec gate deterministic. The LLM may only escalate, and the diff is re-checked after build.
6. Hold work-item state in D1. Use Workflows per stage or as timers.
7. Add lease fencing tokens and one branch per run.
8. Add holdout acceptance tests. Pair the gate-time metric with rework and escaped-defect metrics.
9. Read policy from the default branch only. Treat diffs to `.factory/` as self-modify.
10. Fix the vocabulary (factory, stage, preset, gate, foreman) in CONTEXT.md.

## Other notable findings
- **Naming:**
  - "Factory" means five things.
  - "Gate", "gatekeeper" and "factory gate" collide. Rename gatekeepers to "connectors".
  - `docs/stages/` collides with pipeline stages. Use `docs/specs/`.
  - Autonomy presets and repo-practice presets collide. Use "autonomy policy" and "project template".
- **One Question object** (domain, assignee, default, blocking, visibility), with sessions as views. That replaces four session types.
- **Two contradictory gate models** (blocking `waitForEvent` vs pending actions with speculative continuation). Pick blocking for v1.
- **The approved spec must commit to the work item's branch**, not to main.
- **`factory/verify`:**
  - Pin the check to the App as its expected source.
  - Bind it to the head SHA.
  - Rely on CI the cloud can read, not on what the runner reports.
  - Verify branch-protection availability on private repos and client repos.
- **Runners:**
  - Shared runners are remote code execution on someone's laptop. Make runners owner-only by default, with an explicit allowlist.
  - Client isolation needs a separate OS user or container per client until per-item grants exist.
  - Model "rate-limited until T" as a runner state.
  - Check whether subscription terms allow unattended or team use.
- **Data residency:** transcripts and screenshots from client apps (e.g. health data) land in Cloudflare. Add a per-project evidence policy.
- **Multi-session merged view:** high complexity and wrong-session hazards. One identity in several orgs gives the same view.
- **Human-in-the-loop:**
  - Ask fewer questions. Record reversible choices as assumptions.
  - Exclude security and irreversible questions from bulk accept.
  - Define "autonomy rate".
  - Specify timeouts, backup owners, and what happens to the runner slot when an item is paused.
- **Sequencing:** pull notifications, runner health and three metrics earlier. The second-riskiest assumption is that `runner-orca` can reliably detect completion and failure.
