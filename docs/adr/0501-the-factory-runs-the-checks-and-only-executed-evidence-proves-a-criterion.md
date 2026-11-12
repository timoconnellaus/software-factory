# ADR 0501: The factory runs the checks, and only executed evidence proves a criterion

Status: accepted, 2026-11-12 ([spec 51](../specs/51-verify-from-the-factorys-own-evidence.md), PR B).
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
  fix, up to the project's `retryLimit` rounds. After that the item asks a person (Workflow v8; v7 is spec 50 part C's, PR #79),
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

> Amended 2026-11-12 (PR #73 review). The first version ran a local check as the runner's owner,
> outside any sandbox, on whatever the session left in the worktree. Changed:
>
> 1. **Isolation or nothing.** A check runs through the adapter's `exec` (a container job: a check
>    container with no network, no credential, no terminal), or under the host's OS sandbox with the
>    harness's floor (ADR 0270): Anthropic's sandbox runtime (`srt`, the engine under Claude Code's
>    sandbox) with `harness-claude`'s own deny lists (`denyHome`), the runner's dirs and the owner's
>    checkouts unreadable, writes only to the check's tree and its temporary HOME and temp, the
>    harness's credential-free environment, and the job's network allowlist. Where neither exists
>    (no `sandbox-exec`, no bubblewrap and socat), each check is reported **"not run: no isolated
>    exec on this runner"**: it fails, so the verdict can't pass on it and a person decides.
> 2. **A clean tree of the exact commit.** Every round runs on a fresh copy of the commit made by the
>    host (`read-tree` + `checkout-index` through a throwaway index, so no ignored files and no git
>    dir; never `git archive`, which honours `export-ignore`). A project declares its install as a
>    check of its own (e.g. `pnpm install --frozen-lockfile`). The check container mounts only that
>    tree and the job's pnpm store; with no network it installs offline from the store.
> 3. **Git guards after every check and fix round.** Before any host git that follows code the job
>    ran, the host compares the worktree's sensitive git config with its value before the session
>    and calls the adapter's optional `checkWorkspace` (the container adapter's `checkJobGitDir`). A
>    finding fails the job; nothing is pushed.
> 4. **The pushed head is the checked head.** The host never commits after the last round; it
>    pushes exactly the commit the last round ran on.
> 5. **An attached PR's checks run before its reviewer session**, on the PR's head, in the verify
>    job (no fix rounds). The reviewer is told their names (`verify #b: check names`).
> 6. **Proof.** The links come from the human-approved spec where a criterion carries
>    `[checks: a, b]`; otherwise they are the reviewer's, labelled "linked by the reviewer". A static
>    check (lint, typecheck, format) never proves a criterion, and a CI check run proves one only when
>    the spec names it. Proven is marked **weakened** when the tests-intact guard (ADR 0500) found
>    gate-file edits on the SHA.
> 7. **The verdict without declared checks** keeps the reviewer's failing check as a reason, as
>    before this ADR.
> 8. **Versioned.** Everything here applies from Workflow v8 (`hostChecksOn`): an item that started
>    earlier gets no checks on its jobs and keeps the old verdict.
> 9. **`run.handBack`** accepts check results only for the run's head (a build's pushed head, a verify
>    job's asked head) and its ancestors on GitHub, and redacts token shapes from the log tails
>    again; the host already redacts them and the job's own tokens.
> 10. **The merge queue's carried packet** records `checksRanOn`; `factory/verify` and the packet
>     say the checks ran on that SHA, not on the updated head.
> 11. `continueSession` is off for stream-json sessions until tested against a real one (a failing
>     check there goes to a person). A hung check settles on `exit` after the kill, even when a
>     detached process holds its output, and the checks get a timer of their own.
