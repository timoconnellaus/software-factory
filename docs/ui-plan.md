# Factory UI: plan

## Context (from the product plan)
- One user (you). The scarce resource is your **attention**.
- Gates: spec approval (policy-sized), merge, questions. Merge, deploy and self-modify always need you.
- Each PR comes with a **review packet**: checks, acceptance criteria, screenshots, reviewer verdict.
- Surfaces: web dashboard, phone push, runner UIs (Orca) for takeover.
- Config lives in `.factory/` in git, with presets and a floor.

## Decisions
- **Design language: shadcn/ui.** Zinc neutrals, Geist font, sidebar app shell, Card, Badge, Button, Table and Tabs. Status is shown with small coloured dots rather than coloured fills.

- **Design system** lives in `.kim/design-system/`: `tokens.css` (zinc colours, light and dark, plus **factory status tokens**: waiting, running, done, failed, idle, local), `components.css`, a `components.html` gallery and a README of rules (status shown as dots, one primary button per card, a ring on cards that need you). All mockups link to it.

- **Home: Inbox-first** (chosen). The board and the KPIs live on the Work and Metrics pages.
- **Screens: all 10 in scope, shipped iteratively** (release order to be proposed). Home/inbox, work item detail, review packet, work list/board, new work, projects, runners, metrics, live run view, settings.
- **Auth:** Better Auth with orgs + multi-session. The sidebar top is an **org & account switcher** with an "All factories" view across every signed-in account (see mockup).

- **Config is read-only in the UI.** Projects and Settings show the resolved `.factory/` (preset + overrides + floor) and link to the file in git. Edits happen in git.

- **Phone: no app yet. A native app comes later.** The web app stays responsive, but there's no PWA or push work for now. The outbox and notification events are still built, so the native app can plug into them.
- **Stack:** TanStack Start + shadcn/ui on Workers (same as the CRM).
- **Theme:** follows the system (light/dark).

- **Multi-user:**
  - Approvers are set per project in `.factory/`.
  - When the requester's runner isn't available, the job falls back to the pool or queues. This is configurable.
  - Default view is "All factories" across accounts.
  - Every user gets a Personal org automatically.
  - Users own runners and share them into orgs.
  - UI includes: sign-in, "requested by", a per-user inbox, the Runners page with owner + "my runners", "runs on" in New work, and a team view.

- **Sign-in:** GitHub + passkeys. Repo access goes through a GitHub App per org.

- **Review packet:** sections are **configured per project** in `.factory/` (`reviewPacket.sections`). The full set is: verdict row, what changed, criteria + evidence, reviewer notes, screenshots, risk flags, an inline diff (collapsed) and a deploy preview link.

- **New work:** routing preview collapsed to one line; expand to see details or change the runner.
- **Live run:** steer, take over locally, open in the runner's UI (only when the runner declares that capability), stop, and progress against criteria. Summarised steps are the default.
- **Work item detail:** layout approved (stage steps + Timeline/Spec/Runs/Review packet tabs, sidebar with criteria + details).
- **Mockups for the remaining screens are done:** Projects (read-only resolved config), Runners, Metrics, Org settings, Team view.

- **Planning is built in.** It is native to the factory, not a kim integration. The interviewer patterns (questions with defaults and recommendations, a living spec, mockups/designs) become the factory's planning stage. See the 'Planning (built-in)' mockup.

- **Projects:** two tabs, "Resolved config" (each value with its source: preset, `.factory/` or floor) and "Raw YAML" (linked to GitHub).
- **Release order:**
  - **R1:** sign-in + org switcher, New work, Inbox, Work item detail, Review packet
  - **R2:** Live run + take over, Work board, Runners
  - **R3:** Projects, Org settings, Team view
  - **R4:** Metrics

- **Decision domains (proposed):** `.factory/` declares domains (product, architecture, security…) and their owners. Triage tags which domains a work item touches, and each planning question is tagged and routed to that domain's owner. Spec approval is split per domain. Example: in patientos, James owns product, you own architecture and security.

_Open:_ planning scope, domains, unplanned-domain handling.
