# ADR 0021: Governed local sessions

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
People still work in local Claude sessions. If those sessions bypass the factory, the factory loses
visibility and its gates mean nothing.

## Decision
Principle: **local sessions can do anything locally, but nothing reaches main except through the factory gate.**
1. **Projection.** A committed baseline (generated AGENTS.md/CLAUDE.md section, skills, commands) plus
   runtime injection of the live work item (spec, acceptance criteria, stage) through a SessionStart hook.
2. **Participation.** Exploring and reading are free. Once the work is clear, the session creates or
   claims a work item over MCP, which takes a **lease** so cloud runs back off. It reports its stage
   and hands back with a handoff summary.
3. **Auto-registration** (optional capability). Runners that launch sessions, like Orca, attach them
   to the work item.
4. **Hooks.** Writes, commits and pushes are blocked until a work item is claimed. A heartbeat keeps
   the lease alive.
5. **Remote enforcement.** The `factory/verify` check and branch protection ([ADR 0020](0020-verification-and-review-packet.md)).

## Consequences
- Hooks are a convenience; remote enforcement is the guarantee.
- Open question: lease length and what happens to a cloud run when a local session claims mid-run.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): a lease claim returns a **fencing token**; a local claim mid-run bumps it, the cloud
> run is stopped and its slot released ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md)).
> Lease length is still open. "The factory gate" in the principle means the required
> `factory/verify` check plus the merge gate ([ADR 0037](0037-factory-verify-pinned-and-sha-bound.md));
> the hooks step needs the harness's `hooks` capability.
