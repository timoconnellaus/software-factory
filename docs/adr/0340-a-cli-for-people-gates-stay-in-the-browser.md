# ADR 0340: A CLI for people; gate decisions stay in the browser

Status: accepted, 2026-11-12. Spec [07](../specs/07-cli.md). Builds on
[ADR 0003](0003-operations-registry.md), [0004](0004-invoke-pipeline-and-gate.md),
[0005](0005-hybrid-coordinator.md) and [0056](0056-runner-device-login.md).

## Context
Twice while unsticking work item #1, an agent session couldn't answer "what state is this item
in?". There was no D1 access on the machine, and the app needs a browser sign-in. People want the
same from a terminal. Every factory verb is already an operation with a schema and a description,
so a CLI is one more surface calling `invoke()`.

The risk is the token. A CLI credential on a machine where agent sessions run is a credential those
agents hold. If it could decide gates, an agent could approve its own merge. That breaks "merge,
deploy and self-modify always go to a human" (ADR 0005, AGENTS.md).

## Decision
1. **Gate decisions are browser-only, enforced in `invoke()`.** An operation may be marked
   `browserOnly`, optionally depending on its input. A human calling one from any surface other
   than `app` gets `forbidden`.
   - **Marked:** spec and merge decisions, `approval.decide`, answering questions and accepting
     their defaults, approving a runner or CLI login, registering a runner or rotating its key,
     and turning a kill switch off.
   - **Not marked:** turning a kill switch on, so stopping things from a terminal stays possible.
   - The mark lives on the operation, so MCP inherits it.
2. **People log in by device code**, like runners (ADR 0056). The person approves the code in the
   app and picks a scope there.
   - The CLI asks for a scope, but the person's choice wins.
   - The token is minted when it's collected, handed over once, and stored only as its SHA-256.
   - It expires after 30 days, and its owner can list and revoke it.
3. **Two scopes:** `read` allows only `read`-risk operations; `write` allows everything else the
   person may do, minus browser-only operations. The CLI's default is `read`, the one to give agent
   sessions.
4. **One endpoint:** `sf-engine` serves `/cli/v1` next to the runner channel.
   - The token sets the actor as `human` and the origin as `cli`; nothing in the request does.
   - Permissions, policy, the gate check and the audit journal are `invoke()`'s, unchanged.
   - MCP will use the same door.
5. **`local/cli` (`sf`) is a thin client.** `sf call` covers every operation from the registry,
   and a few hand-made commands cover the daily views.

## Consequences
- **Agent sessions can read the factory's state** with a `read` token, which is the common need,
  and can't loosen anything.
- **Approvals happen in the app.** A person with a `write` token still opens the app to approve;
  `sf open <n>` takes them there.
- **The browser-only list is policy in code.** Adding an operation that decides a gate means
  marking it, and the registry test checks that every `gateKind` decision operation is marked.
- **A leaked token is bounded:** read-only by default, 30 days, revocable, and never able to
  approve.

## Amendment, 2026-11-12
[ADR 0391](0391-the-client-door-desktop-devices-and-presence.md): the CLI door becomes the client door (`/client/v1`, `/cli/v1` kept), and a **desktop** device may decide the presence-decidable gates (spec, merge, `approval.decide`, questions) with a Secure Enclave presence proof bound to that exact call. Everything else stays browser-only, and CLI tokens are unchanged.
