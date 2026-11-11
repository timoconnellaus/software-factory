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
