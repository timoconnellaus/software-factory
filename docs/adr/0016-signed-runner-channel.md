# ADR 0016: Signed runner channel

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Runner hosts sit on home networks and laptops. They must not expose a port, and the control plane
must trust what they report. Borrowed from Relationship OS ADR 0250.

## Decision
- The runner host only connects outbound to the control plane.
- Every call in either direction is signed with HMAC over the method, path, body hash and timestamp,
  valid for 5 minutes, and idempotent.
- Each runner has its own key, issued when it registers.

## Consequences
- A runner can be revoked by rotating its key.
- Open question: transport for job assignment (long poll, WebSocket to a Durable Object, or queue pull).
