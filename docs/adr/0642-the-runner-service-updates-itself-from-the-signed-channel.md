# ADR 0642: The runner service updates itself from the app's signed channel

Status: proposed, 2026-11-13 (revised the same day after design review). Spec
[45](../specs/45-runner-service-on-a-mac.md) §5. Builds on
[0640](0640-the-mac-runner-is-a-signed-bundle-run-by-a-launchagent.md),
[0643](0643-the-runner-bundle-checks-its-own-seal-at-every-start.md),
[0360](0360-runners-update-themselves-to-the-deployed-commit.md),
[0520](0520-runners-keep-claiming-while-an-update-waits.md) and [0016](0016-signed-runner-channel.md);
spec [40](../specs/40-desktop-app.md) M4 (how the app verifies its own updates).

## Context
The bundled runner has no git checkout, so ADR 0360's self-update can't run, and it reports no
version. Today it moves only when the app updates, and after a `RUNNER_COMPAT` bump it claims
nothing until then. As a service (ADR 0640) it must update itself without the person, and never
mid-job. The engine names the version to run as a commit, `RUNNER_SHA` (ADR 0520), and takes the
runner's word on whether it is current.

A commit id has no order. The first draft matched the desired commit exactly against the channel's
entries; stable is published by hand, so a stable Mac whose desired commit was only on canary was
"blocked" forever and claimed on old code indefinitely. Its rollback lived in the new version and
counted starts, so a version that ran but never heartbeated stayed pending forever.

## Decision
1. **A runner sequence orders versions.** The deploy computes `runnerSeq`, the first-parent count of
   `main` up to `runnerSha`, which only grows, and the engine's heartbeat answer gains an optional
   `desiredRunnerSeq` (an optional field, no compat bump). Each release seals its own `runnerSha`
   and `runnerSeq` in `version.json`.
2. **Versions come from the app's channel.** Each desktop release also publishes the notarized
   `SF Runner.app` as a zip and adds `{ version, sha, runnerSha, runnerSeq, compat, sha256, size }`
   to its channel's runner index, written after the zip.
3. **Which version is a pure function** of the installed version, the index, the desired sequence,
   `minRunnerCompat`, the skip list and the clock. At or above the desired sequence is current.
   Behind, it moves to the channel's highest suitable entry even if that is still behind, so a
   stable Mac follows stable. With nothing newer on its channel it is `awaiting-release`: normal on
   stable, and on canary `release-missing` after 2 hours, shown to the person. It keeps claiming
   either way. It never downgrades unasked.
4. **Verified as the app verifies itself, then self-tested by its own launcher**: the requirement
   with the Team ID from the verifier's signature, `spctl`, the sealed `version.json` matching the
   entry and channel, the zip's sha256 for transport, then the new launcher's `selftest`, which
   checks its own seal and loads every module.
5. **When: ADR 0520, unchanged.** It keeps claiming while an update waits, then light only, then
   nothing, and swaps at the first heartbeat with no job running and no claim in flight.
6. **Confirm within a deadline, or roll back.** The guard is the runner's parent process. The first
   successful heartbeat confirms. The third unconfirmed start rolls back. Ten minutes after a start,
   the runner's recorded heartbeat attempts decide: an answer from the engine that wasn't success,
   or no attempt at all, is broken and rolls back; only "no answer at all" (DNS, connect, TLS) is
   offline, which waits without counting. A rolled-back version is skipped for 24 hours, then 7
   days, then until a person retries it.
7. **The app is the backstop.** At every launch it repairs: installs its bundled copy when `current`
   is missing, fails verification or was refused by its launcher; rolls back an update pending over
   15 minutes with no guard running; and offers a newer bundled copy to the service, which applies
   it when idle. An app update therefore always repairs the runner.
8. **A compatibility bump needs a release, and the deploy enforces it.** `runner-compat.ts` refuses
   an engine deploy whose `RUNNER_COMPAT` is above a channel's newest runner: it waits up to 60
   minutes for canary's release of the same push, and refuses stable unless a person has set
   `RUNNER_COMPAT_STABLE_GAP` to that compat, acknowledging stable Macs stop claiming until the next
   stable release.
9. **The heartbeat's report** keeps ADR 0360's shape with the bundle's `sha`, plus `compat` and
   `runnerSeq`.

## Consequences
- A runner-code merge reaches canary Macs with the canary release of it (or a later one), and stable
  Macs with the next stable release, within ADR 0520's bounds, with no click.
- A version that heartbeats but fails its jobs isn't rolled back automatically; the card offers a
  manual rollback to `previous`.
- Without the app running, a new launcher that dies before its guard counts the start is restarted
  by launchd every 30 s until the app opens and repairs it.
- Each runner update downloads the whole bundle (about 45 MB zipped, mostly Node). That is
  acceptable, since runners update only when runner code changes.
