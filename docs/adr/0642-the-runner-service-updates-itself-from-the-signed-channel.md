# ADR 0642: The runner service updates itself from the app's signed channel

Status: proposed, 2026-11-13 (revised the same day after design review, and again after the second:
the sequence covers the bundle's build, stable comes from main's first-parent line, the deadline
counts awake time and rolls back only on evidence against the version, corrupt state fails safe,
repair never goes below the highest confirmed version, and crashes after confirming count). Spec
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
   and `runnerSeq` in `version.json`. The runner's paths include what builds the bundle (the
   launcher, `bundle-runner.mjs`, `vendor-node.mjs` with Node's pin), so a launcher or Node fix
   publishes a higher sequence; checkouts pay one idle restart for it. Every release, stable
   included, must be built from a commit on `main`'s first-parent line, or two builds could share a
   sequence.
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
6. **Confirm within a deadline, or roll back, only on evidence against the version.** The guard is
   the runner's parent process. The first successful heartbeat confirms. Time is awake time (the
   uptime clock), so sleep never runs a deadline out. The third **failed** start (a crash, exit 78,
   a hang the guard killed; not a logout or stop, which the guard records on SIGTERM) rolls back.
   At 10 awake minutes the recorded attempts decide: three engine refusals of what the version sent
   (`rejected`) or failures in its own code (`error`) in a row, or no attempt at all, roll back; no
   answer, a 5xx, 408, 429, a redirect or anything that isn't the engine's JSON is `unreachable`
   and waits; a 401 or 403 is the key's problem, not the version's, so it never rolls back and the
   person is asked to pair again. For 24 awake hours after confirming, the third failed start still
   rolls back. State files are written by rename; one that doesn't parse is evidence of nothing, so
   nothing rolls back on it, and the app rewrites it. A rolled-back version is skipped for 24 hours,
   then 7 days, then until a person retries it.
7. **The app is the backstop.** At every launch it repairs: when `current` is missing, fails
   verification or was refused, it restores `previous` (if `current` was pending), else `current`'s
   own version fetched again, else its bundled copy, but never below the highest sequence ever
   confirmed without the person choosing; rolls back a pending update whose starts failed or that
   never heartbeated, with no guard running; and offers a newer bundled copy to the service, which
   re-verifies it (the socket is open to any same-user process) and applies it when idle. An app
   update therefore always repairs the runner.
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
