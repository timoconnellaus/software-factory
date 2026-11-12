# ADR 0520: Runners keep claiming while an update waits; only a compatibility bump drains them

Status: accepted, 2026-11-12. Spec [38](../specs/38-runner-updates-without-draining.md). Amends
[ADR 0360](0360-runners-update-themselves-to-the-deployed-commit.md). Builds on
[0014](0014-runners-are-adapters.md), [0016](0016-signed-runner-channel.md),
[0100](0100-runner-contract.md) and [0301](0301-runner-capacity-has-heavy-and-light-pools.md).

## Context
Under ADR 0360 every merge to `main` deploys, every deploy moves `DEPLOYED_SHA`, and a runner that
is behind stops claiming anything, verifies included, until every running job ends. Builds take
10–30 minutes or more and merges land every few minutes, so on the M5 the runner spent most of its
time draining and the verify queue backed up (2026-11-12). Most of those deploys changed no runner
code at all.

## Decision
1. **The desired version is the last runner change, not every deploy.** The deploy computes, with
   git, the last commit on `main`'s first-parent line, at or before the deployed one, that changed
   runner code, and sets it on `sf-engine` as `RUNNER_SHA` next to `DEPLOYED_SHA`. The heartbeat
   answers `desiredVersion = RUNNER_SHA`, or `DEPLOYED_SHA` when the deploy couldn't tell (a shallow
   clone, an older deploy). The engine stays dumb: it never runs git.
   - **Runner code** is `local/runner-host`, every `packages/runner-*` and `packages/harness-*`, and
     their workspace dependency closure through `dependencies`, `optionalDependencies` and
     `peerDependencies` (from the package.json files, not a hand list), plus the root
     `package.json`, `pnpm-workspace.yaml` and `.nvmrc`. Not `devDependencies` (tooling never runs
     on a host) and not `pnpm-lock.yaml` (a runner installs its own commit's lockfile, which matches
     its own package.json files).
   - **First-parent** so the answer is one of `main`'s own commits, which passed CI and the merge
     gate, never a PR branch's commit.
   - **A runner at or ahead of the desired commit is current.** A runner still on a later deployed
     commit (from before this change, or from a deploy that has since been followed by engine-only
     ones) already runs that code. Only a runner strictly behind it updates.
2. **A pending update doesn't stop claims.** A runner behind the desired commit keeps claiming on
   its current code and updates at the first heartbeat where no job is running.
3. **Caps, so a busy runner still updates.** While the update has been pending:
   - **30 minutes:** it stops claiming heavy jobs (build, verify) by reporting its heavy pool full,
     and still claims light ones (triage, spec, planning). Jobs already claimed, verifies included,
     run to the end.
   - **60 minutes:** it claims nothing, so light jobs can't hold the update off forever.

   Both are in code (`UPDATE_HEAVY_CAP_MS`, `UPDATE_ALL_CAP_MS`) and can be set in `runner.json`
   (`updateCaps`) for tests only. No job is ever cancelled for an update. A planning session that
   stays open still holds the update off past 60 minutes; spec 39 (re-adopting live jobs after a
   restart) is what removes that.
4. **A breaking change drains at once, through `RUNNER_COMPAT`.** `packages/runner-contract`
   exports `RUNNER_COMPAT`, a number. The engine sends its own as `minRunnerCompat` on every
   heartbeat; a runner whose code has a lower one claims nothing from that heartbeat on, and
   updates when its running jobs have ended. A runner that can't update (blocked) still claims
   nothing, and says why.
   - **A number, not a commit SHA.** It is set by hand in the PR that makes the breaking change, so
     the change and its bump are reviewed together. A SHA can't name the commit it is written in
     (it would need a second commit or a deploy-time computation), and comparing one needs an
     ancestry check against a commit the runner may not have fetched. A number needs no git, and a
     host that isn't a git checkout (no self-update) can still refuse to claim.
5. **The compatibility rule** (also in `RUNNER_COMPAT`'s comment and `wire.ts`'s header). While
   `RUNNER_COMPAT` stays the same, the engine serves a runner one or more commits behind it:
   - **Runner → engine requests** are validated by the engine with zod. A field is added only as
     optional, an enum only grows, and nothing an older runner sends is refused or changes meaning.
   - **Engine → runner answers** are read without validation (`JSON.parse`), and the host ignores
     fields and command kinds it doesn't know, so a new answer field or command kind is fine when
     an older runner can safely ignore it.
   - **A job an older runner can't run correctly** (a new stage, a new way to run one, a job field
     it must act on) is gated on a capability the new runner declares, so `canRun` never places it
     on an older runner.
   - **Anything else** (removing or renaming a field or call, changing what one means, a stricter
     request schema) bumps `RUNNER_COMPAT` in the same PR.
   - **Never bump `CONTRACT_VERSION`.** The engine refuses a heartbeat whose manifest names another
     contract version, so a runner on the old one could never learn it should update. A breaking
     change bumps `RUNNER_COMPAT` instead.

   Checked against today's code: requests already add fields as optional (`version`, `accounts`,
   `light`), responses are not validated by the host, unknown commands fall through the host's
   `if` chain, and new job kinds (planning, chat, terminal) are already gated on the light pool or
   a capability. So the rule holds as written, at `RUNNER_COMPAT = 1`.

## Consequences
- An engine-only merge moves no runner. A runner-code merge moves runners at their next idle
  moment, within about 60 minutes plus the longest running job on a busy runner.
- The engine runs ahead of runners as a matter of course: every engine change has to follow the
  compatibility rule. A reviewer who sees a wire or job-shape change asks "does this bump
  `RUNNER_COMPAT`, or need a capability?".
- Deploy order: the engine, with `RUNNER_SHA` and `minRunnerCompat`, deploys before any runner runs
  this code (a runner only updates to a deployed commit, so this holds by construction). A runner
  on this code against an older engine sees no `minRunnerCompat` and never force-drains.
- The deploy needs full history (`fetch-depth: 0`). Without it `RUNNER_SHA` is left unset and
  runners get `DEPLOYED_SHA`: the old behaviour, which is safe.
- The inbox's health line takes a runner's own `current` at its word: only the runner can tell, with
  git, that it is ahead of the desired commit.
