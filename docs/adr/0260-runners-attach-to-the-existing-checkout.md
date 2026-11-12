# ADR 0260: Runners attach to the machine's existing checkout of a repo, by canonical identity

Status: accepted, 2026-11-11 (incident [2026-11-11 bootstrap #5](../incidents/2026-11-11-bootstrap.md#5-the-runner-added-a-second-orca-repo)).
Amends [ADR 0250](0250-runner-host-pushes-and-harness-projection.md) point 2. Builds on
[ADR 0014](0014-runners-are-adapters.md), [0016](0016-signed-runner-channel.md) and
[0100](0100-runner-contract.md).

## Context
On the M5, during work item #1, Orca showed the project `github:timoconnellaus/software-factory` with
two source repos: the owner's `~/orca/projects/software-factory` and the runner's own clone under
`~/.local/state/software-factory/runner/repos/`. Both are called `software-factory`, so the sidebar
showed confusing duplicates. `runner-orca`'s `prepareWorkspace` always registered the host's clone and
never looked for a repo Orca already had for the project, and `release` unregistered it again, so
every job churned a new repo id. ADR 0250 had said the runner never uses the owner's checkouts. The
brief said "isolated workspace" and nobody specified "resolve the existing Orca project".

The owner's requirement: a runner links to the existing Orca project, for every project, and never
adds a second one.

## Decision
1. **The workspace resolution rule (runner contract).** To prepare a job, a runner finds the checkout
   its machine already has for the job's repo by **canonical identity**, `github.com/<owner>/<name>`
   lower-cased (`canonicalRepoKey`, `canonicalKeyFromUrl` in `runner-contract`), and makes the job's
   workspace there. The contract has an optional `RunnerAdapter.resolveCheckout(job)`; the host fetches
   into the checkout it names instead of cloning. Isolation comes from the job's own worktree, never
   from a second checkout.
2. **Orca.** `runner-orca` reads `orca repo list --json` and matches `gitRemoteIdentity.canonicalKey`
   (falling back to the remote URL, then to `origin` in the checkout). The owner's checkout wins over
   the runner's own clone, and among several the earliest added. The job's worktree is created **in
   that repo** (`orca worktree create --repo id:<repo> --comment sf-job:<jobId> --branch <run branch>`).
3. **The owner's checkout is never touched.** The host fetches the item branch **by explicit URL**
   into its own namespace, `refs/software-factory/heads/<item branch>`, with `--no-write-fetch-head`,
   https only, and the job token in that one git process's environment, served by a credential helper
   given on the command line (`-c credential.helper=…`). Nothing is written to the checkout's config:
   no `remote set-url`, no helper, no push URL. The worktree starts from the fetched SHA. The host
   never checks out in, commits in or pushes from the owner's main worktree; it pushes only from the
   job's worktree, by URL, as before. The adapter deletes only factory run branches
   (`factory/<n>-<slug>-run-<k>`), and the harness is denied reading the main checkout (its `.env`
   files, other work) through `protectPaths`. The one shared write is the harness's private file names
   in the repo's `.git/info/exclude`, which git has only per repository.
4. **Fallback: clone once, keep it.** Only when no Orca repo exists for the remote does the host clone
   into its stable path (`<state>/repos/<owner>/<name>`), and the adapter registers it **once,
   permanently**. The folder name is the repo name, so Orca names it after the project. Later jobs
   find it by identity (or by its path, for a clone whose remote Orca can't read).
5. **`release` never unregisters a repo.** It removes only the job's worktree, its run branch and its
   run directory.
6. **Migration.** On startup, after reaping orphaned job worktrees and before the first claim, the host
   retires any repo it registered earlier (under its state dir) for a remote that also has an owner
   repo: it removes that repo's leftover `sf-job:` worktrees, unregisters it
   (`orca project setup-delete`), deletes the clone and prunes the owner's worktree list. It skips a
   repo a live job still uses; new jobs already go to the owner's repo, so the next start finishes it.
   In-flight jobs are not moved between repos: a job worktree can't change repos, and at startup
   there are none.
7. **`sf-runner doctor`** flags an Orca project with more than one source repo for one remote and any
   `sf-job:` worktree without a live job; `--fix` reaps the orphans and runs the migration. Two of the
   owner's own checkouts of one remote are reported but left alone. The running host records its live
   jobs in `<state>/live-jobs.json` (with its pid) so `doctor` and `status` can tell a live job from an
   orphan; with a service up and no such file, job worktrees count as live and nothing is removed.

## Consequences
- Orca shows one repo per project; a job appears as a worktree of the owner's own project, which is
  where a person looks to take it over.
- The owner's repo gains `refs/software-factory/heads/*` refs (one per item branch fetched) and the
  job worktrees' metadata under `.git/worktrees/` while a job runs. Both are the host's; `git gc` and
  `release` clean what they should.
- The owner's local git config now applies to job worktrees (a hook path, a URL rewrite). The host
  still runs its own git with hooks off and a protocol allowlist, and the before/after config check
  still guards the push. A local credential helper in the owner's checkout would be visible to the
  harness's git; the harness can't push (`git push` is denied and it has no token), so this is
  accepted for now.
- Runner adapters for other runners (dev boxes, sandboxes) that have no registry of checkouts leave
  `resolveCheckout` out and keep the host's clone.

## Rule for every runner adapter
Runner adapters resolve existing workspaces by canonical identity and never create a duplicate
registration of a repo the runner's machine already has. Registration is once and permanent; per-job
state is a worktree and a branch. This is in `.factory/checks/runner-adapters.md`.

> Amended 2026-11-12 ([ADR 0380](0380-runner-local-tmux-and-hook-status.md), spec
> [30](../specs/30-runner-local-without-orca.md)): with Orca gone (`runner-orca` deleted), the
> checkouts no longer come from Orca's repo list. Point 2 now reads: `runner-local` scans the
> directories listed in `runner.json` `checkouts` and takes the git repo directly under one of them
> whose `origin` is the job's repo (`canonicalKeyFromUrl`), the first in the order listed. It makes
> the job's worktree there with plain `git worktree add` (hooks off, no upstream written) at
> `<state>/worktrees/sf-<jobId>`. Point 4: the fallback is still the host's clone, made once and
> kept, but nothing is registered anywhere. Point 6, the migration, is gone; in its place
> `sf-runner login` and `doctor --fix` fill `checkouts` once, when unset, with the parent
> directories of Orca's repos if Orca is installed, else `[]`. Point 7: `doctor` reports two
> checkouts of one remote under those dirs (not fixable) and `sf-*` worktrees or tmux sessions with
> no live job (fixable). Points 1, 3 and 5 hold unchanged. Job worktrees an older runner made in
> Orca are not reaped by the new one.
