# ADR 0441: The factory runs the checks, and only executed evidence proves a criterion

Status: accepted, 2026-11-12 ([spec 26](../specs/26-verify-from-the-factorys-own-evidence.md), PR B).
Amends [ADR 0020](0020-verification-and-review-packet.md), [ADR 0231](0231-verify-verdict-and-the-github-connector.md)
(the verdict) and [ADR 0014](0014-runners-are-adapters.md) (an optional `exec` on the adapter).

## Context
Verify's verdict used the reviewer agent's own report of whether lint, typecheck and tests passed,
and whether each acceptance criterion was met. CI on GitHub is read too, but CI is whatever the
repo's workflows run, and the criteria were "met" because the reviewer said so.

## Decision
- **The project declares its checks** (`checks: [{ name, run, timeoutMinutes }]` in its config,
  plus any a workflow adds). Removing or changing one loosens the config: self-modify, a person.
- **The runner host runs them, not the agent.** After a build session's turn ends, the host commits
  what the session left and runs each check in the job's worktree, on the head it will push,
  through the adapter's optional `exec` (so a containerised job runs them in its container). Only
  an adapter without `exec` gets a local process in the worktree. The host reports exit code,
  duration and a log tail per check on the hand-back; `run.handBack` stores them in
  `core_check_results` against the work item and head SHA. A new head has none.
- **A failure goes back to the same session.** If a check fails and the adapter can steer, the host
  types the exact failure (command, exit code, log tail) into the same build session and checks its
  fix, up to the project's `retryLimit` rounds. After that the item asks a person (Workflow v7),
  never a cold build retry. A session that can't be steered hands back at once and asks a person.
- **The verdict uses executed results.** `reviewPacket.record` passes only when every declared check
  passed on the head SHA, CI is green, the reviewer didn't find a criterion unmet and didn't request
  changes. The agent's own `checks` are ignored.
- **A criterion is Proven only by executed evidence.** The reviewer links each criterion to check
  names (executed checks or CI check runs). The packet marks it **Proven** only when a linked check
  passed on the head SHA; otherwise **Not proven**, the reviewer's evidence shown as opinion. Not
  proven doesn't fail the verdict on its own (a person sees it at the merge gate); unmet does.
- `factory/verify`'s summary lists the executed results and the proven count, and fails when a
  declared check failed or didn't run on the SHA.

## Consequences
- The build job runs a little longer, and a check that needs services the worktree lacks fails
  until the project declares a command that works there.
- An adapter that declares `steer` must accept a second `events()` call after a steer that follows
  `session.ended`: it reports the turn the steer started (runner-local: one small change).
- The reviewer can still argue a criterion is met, and a person can merge on its word, but the
  packet says it is opinion.
