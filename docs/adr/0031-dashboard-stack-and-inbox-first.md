# ADR 0031: Dashboard stack and inbox-first home

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
The scarce resource is the approver's attention. Relationship OS uses TanStack Start and shadcn/ui on Workers.

## Decision
- TanStack Start + shadcn/ui on Workers: zinc neutrals, Geist, sidebar app shell. Status is shown
  with small coloured dots, not coloured fills. Theme follows the system.
- Home is the **inbox**: pending actions for the signed-in user. The board and KPIs live on Work and Metrics.
- Release order: **R1** sign-in + org switcher, New work, Inbox, Work item detail, Review packet;
  **R2** Live run + take over, Work board, Runners; **R3** Projects, Org settings, Team view; **R4** Metrics.
- The web app is responsive; no PWA ([ADR 0012](0012-outbox-and-notifications.md)).

## Consequences
- Design tokens and components live in `.kim/design-system/`; mockups in `.kim/mockups/`.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): **R1 keeps everything** (orgs, multi-session, decision domains, clarification sessions,
> shared runners) but is built in **three internal milestones**: (a) the core loop end to end for
> one user and one repo, usable as soon as it lands; (b) orgs and multi-session; (c) decision
> domains, clarification and shared runners. R1 also gains web push with deep links
> ([ADR 0040](0040-web-push-and-wip-backpressure.md)), a WIP limit with backpressure, an **inbox
> grouped by project**, a **runner health line**, and early metrics (gate time, send-back rate,
> cycle time, "opened full diff?"). Web push needs a service worker but not an installable PWA, so
> "no PWA" still holds.
