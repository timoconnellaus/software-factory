# ADR 0642: The runner service updates itself from the app's signed channel

Status: proposed, 2026-11-13. Spec [45](../specs/45-runner-service-on-a-mac.md). Builds on
[0640](0640-the-mac-runner-is-a-signed-bundle-run-by-a-launchagent.md),
[0360](0360-runners-update-themselves-to-the-deployed-commit.md),
[0520](0520-runners-keep-claiming-while-an-update-waits.md) and [0016](0016-signed-runner-channel.md);
spec [40](../specs/40-desktop-app.md) M4 (how the app verifies its own updates).

## Context
The bundled runner has no git checkout, so ADR 0360's self-update can't run, and it reports no
version. Today it moves only when the app updates, and after a `RUNNER_COMPAT` bump it claims
nothing until then. As a service (ADR 0640) it must update itself without the person, and never
mid-job. The engine names the version to run as a commit, `RUNNER_SHA` (ADR 0520), and takes the
runner's word on whether it is current.

## Decision
1. **Versions come from the app's channel.** Each desktop release also publishes the notarized
   `SF Runner.app` as a zip, and an index per channel (`<channel>-macos-arm64-runner.json`) of the
   recent entries `{ version, sha, runnerSha, compat, sha256, size }`, written after the zips.
   `runnerSha` is the deploy's own `runnerSha()` for the commit built.
2. **Which version is a pure function** of the installed `version.json`, the index, the heartbeat's
   `desiredVersion` and `minRunnerCompat`, and the rolled-back list. ADR 0520's "at or ahead is
   current" is decided without git, by release order: an installed version above the first build of
   the desired `runnerSha` is ahead. No build of the desired commit yet is a transient block, and it
   keeps claiming. It never downgrades, and never retries a rolled-back version.
3. **Verified exactly as the app verifies itself:** the requirement with the Team ID from the
   service's own signature, `spctl`, and the sealed `version.json` matching the entry, the channel
   and a higher version. The zip's sha256 is checked too, for transport. Then a **self-test**: the
   new copy's Node loads every module and parses the config, under the service's environment,
   before it can become `current`.
4. **When: ADR 0520, unchanged.** It keeps claiming while an update waits, then light only, then
   nothing, and swaps at the first heartbeat with no job running and no claim in flight. Download,
   verification and self-test run while it waits. No job is cancelled for an update. After spec 39,
   tmux jobs need no idle moment.
5. **Swap, confirm, roll back.** The swap repoints `previous` and `current` and exits 75, and
   launchd starts the new copy. The first successful heartbeat confirms it and prunes. The guard,
   which uses only Node built-ins and loads the runner with `import()`, counts unconfirmed starts.
   On the third it points `current` back at `previous`, records why, and lists the version as
   rolled back. A copy that can't even load is caught the same way.
6. **The heartbeat's report** keeps ADR 0360's shape, with the bundle's `sha`, so the engine
   changes nothing.
7. **The app's own updates don't move the runner,** and the runner's don't move the app. The app's
   bundled copy only installs the service the first time, or repairs a runner root with no
   verifiable `current`.

## Consequences
- A runner-code merge reaches Mac services once a release with it is published on their channel,
  in addition to ADR 0520's bounds. A stable Mac follows stable releases.
- A `RUNNER_COMPAT` bump stops Mac services claiming until a release with the new compat is on
  their channel: a compat bump needs a canary release, and a stable one for stable Macs
  (`docs/deploying.md`).
- Each runner update downloads the whole bundle (about 45 MB zipped, mostly Node). That is
  acceptable, since runners update only when runner code changes.
