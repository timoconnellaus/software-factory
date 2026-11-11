# Review follow-up: plan

## Where we are
- Merged: scaffold + 32 ADRs + stage specs (PR #2), auth spike (#3), CI/deploy (#4), workflow-gate spike (#5), runner spike (#6), the design review itself (#7), and the domain + Worker secrets (#8).
- Deployed: `sf-app` and `sf-engine` are live, but they're **placeholders** (only `/api/health`). R1 isn't built yet.
- Fable review: see the "Fable design review" doc.

## Decisions
- **Runner credentials:** the cloud mints a per-job GitHub App token scoped to one repo, and the harness runs without the owner's git or cloud credentials. The model subscription stays the owner's. Branch protection allows no admin bypass.
- **Pushing:** the runner pushes with that token to the work item's own branch only.

- **R1 scope: keep everything as planned** (orgs, multi-session, guests/clarification, decision domains, shared runners). R1 is built in internal milestones: core loop first (one user, one repo end to end), then the multi-user layers. The core loop is usable as soon as it lands.

- **R1 additions for away-time and review load:** notifications with deep links (**web push** in the desktop browser), WIP limit/backpressure, inbox grouped by project, runner health line, three early metrics (gate time, send-back rate, cycle time).
- **Spec-gate skip:** LLM triage decides, and every skip decision is logged with its reason. **Later:** a Jev (TypeSafe AI) prompt-injection check on intake text before triage. The API key is still to come, so this is noted as a follow-up and not built in R1.

- **State machine: one Cloudflare Workflow per work item** (ADR 0006 stays). The build must handle the review's concerns explicitly: send-back loops, takeover/pause, Workflow versioning across deploys, step/payload limits, and several intake events merging into one work item (a dedupe key separate from the Workflow id).

- **No standalone review-packet experiment.** The workflow is controlled in the app from the start, and the packet is improved through real use. Add an 'opened full diff?' signal per PR next to the early metrics, to learn where packets fall short.

- **Review packet in the app is the merge gate.** This sets it apart from Warp/Symphony, which review in GitHub. It always links to the GitHub PR for line comments.
- **Vocabulary:**
  - gatekeeper → **connector**
  - `docs/stages/` → **`docs/specs/`**
  - preset → **autonomy policy** + **project template**
  - the foreman's decisions are listed explicitly (size, domains touched, route, retry/escalate), each marked advisory or binding
  - "factory" stays as a layer between org and project

- **Planning model:** one Question object (domain, assignee, default, blocking, visibility). Sessions are views over questions.
- **Adopted from the review:**
  - holdout acceptance tests
  - lease fencing + one branch per run
  - policy read from the default branch only, with `.factory/` diffs treated as self-modify
  - `factory/verify` pinned to the App and bound to the head SHA, relying on CI the cloud can read
  - runners owner-only by default
  - a per-project evidence policy
  - gate time paired with rework/defect metrics, with security and irreversible questions excluded from bulk accept
  - paused items release their slot; timeouts and backup owners
  - **content cut from v1**
- **Tables:** CRM style, `core_*` snake_case, with Better Auth mapped onto it.
- **Branch protection:** `enforce_admins` stays on.

- **Unattended Claude permissions:** project a per-run `.claude/settings.json` through harness-claude now. Use Orca launch args once Orca supports them.
- **Kill switch:** per org and per project.
- **Clients are their own org**, with members, explicitly shared runners, and their own floor and evidence policy.
- **Preview deploys:** later, with separate preview D1/KV/R2. Never against prod data.
- **First projects:** crm (Relationship OS), software-factory (itself), channel-manager.

_Open:_ how review should work on your first projects (crm, software-factory, channel-manager).

## Housekeeping I'll do without asking
- Record the ADR number blocks 0100/0110/0120 in `docs/parallel-work.md`.
- Add `hooks` and `headless` to the CONTEXT.md capability glossary.
- Amend stage 3, criterion 2: a replayed request is answered from the store, not refused.
- Collect the open questions from the ADRs in `docs/handoff.md` (done by the scaffold session).

## Next
Turn the decisions into ADR amendments, then start M5 sessions: R1 build (to the revised scope), the security changes, and the review-packet experiment.
