# ADR 0023: Runners are owned by users; requester-first routing

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
The factory serves a small team. Each member has their own machines and agent subscriptions.

## Decision
- Every runner has an owner (a user), who shares it into orgs and factories.
- Every work item records a **requester**.
- A placement rule such as `route: requester-first` sends the job to one of the requester's runners
  that has the needed capabilities, falling back to the shared pool or a queue. The fallback is configurable.
- Credentials and subscriptions stay with the runner's owner. The factory never holds them.

## Consequences
- The factory needs identity and runner ownership ([ADR 0024](0024-identity-orgs-and-multi-session.md)).
