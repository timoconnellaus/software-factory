# ADR 0540: The phone app is Flutter in `apps/mobile`, with operation types generated from the registry

Status: proposed, 2026-11-12. Spec [60](../specs/60-mobile-app.md). Plan:
[`.kim/plans/2026-11-12-mobile-app-v1-android-flutter.md`](../../.kim/plans/2026-11-12-mobile-app-v1-android-flutter.md).
Builds on [ADR 0390](0390-the-desktop-app-is-the-daily-ui.md) and
[0391](0391-the-client-door-desktop-devices-and-presence.md).

## Context
The owner chose a phone app for Android first, built with Flutter so iOS can follow from the same
code. It covers nearly everything except factory setup. It calls the factory's operations through
the client door, like the desktop app. The phone runs no agents.

The desktop shares its non-React logic with sf-app through `packages/client`, which is TypeScript.
Dart can't import it. Hand-written Dart types for the operations would drift from the zod schemas
the engine enforces, and the door would refuse the drift only at run time.

## Decision
1. **`apps/mobile` is a Flutter app in this repository.**
   - It has no `package.json`, so pnpm and Turborepo don't see it. `pnpm lint`, `typecheck` and
     `test` stay Node-only and run on machines without Flutter.
   - The Flutter version is pinned in `apps/mobile/.flutter-version`, and CI reads it.
   - Its own CI job (`.github/workflows/mobile.yml`) runs only when `apps/mobile/**`, the generator
     or `packages/core/src/operations/**` change. It runs `dart format --set-exit-if-changed`,
     `flutter analyze` (with `flutter_lints`, warnings are errors), `flutter test` and a debug
     build. Biome ignores `apps/mobile`.
   - Android is the only platform target in v1: Android 10 (API 29) or newer, phones only, English.
2. **Operation types are generated, never hand-written.**
   - `packages/client/src/mobile-ops.ts` lists the operations the phone calls. This is the phone's
     `OpMap`, the same idea as the desktop's.
   - A generator (`packages/client/scripts/gen-dart.ts`, run with `pnpm gen:dart`) loads those
     operations from the registry. It turns each input and output schema into JSON Schema with
     zod's `z.toJSONSchema`. It writes:
     - `apps/mobile/lib/gen/ops.g.dart`, with a Dart class per input and output, and
       `fromJson`/`toJson`;
     - a typed `Ops` facade (one method per operation);
     - each operation's risk, and whether it is `presenceDecidable` or `browserOnly`.
   - The emitter handles the JSON Schema subset our schemas produce: objects, strings, numbers,
     integers, booleans, enums, literals, arrays, nullables, and discriminated unions as sealed
     classes. An unsupported construct fails the generator, rather than falling back to `dynamic`.
   - The generated files are committed. The Node CI job runs the generator and fails on a diff, so
     an operation change that breaks the phone shows up in the PR that makes it.
3. **One way to digest an input.** A presence proof is bound to the SHA-256 of an input's canonical
   JSON (ADR 0391). The phone computes that digest in Dart.
   - The generator also writes `apps/mobile/test/vectors/canonical-json.json` from core's
     `canonicalJson` and `inputDigest`.
   - The vectors cover nested objects, key order, `undefined`, unicode, large and fractional
     numbers, and `$bytes`.
   - A Dart test must reproduce every vector byte for byte.
4. **State is Riverpod; routes are go_router; the cache is drift (SQLite).**
   - Riverpod's async providers play the part TanStack Query plays on the desktop: one provider per
     read, invalidated by live events.
   - Reads that load together go through the door's `batch` (up to 20 `read` calls).
   - go_router handles deep links from notifications and App Links.
5. **Live updates are the hub socket in the foreground and push in the background.**
   - In the foreground, the app holds `/client/v1/live` (the person's `ClientHub`, as the desktop
     does). On each `notify` it invalidates what changed, and after a reconnect it re-reads.
   - In the background it holds no socket. Push wakes it ([ADR 0542](0542-push-through-firebase-cloud-messaging.md)).
   - Planning re-reads `planning.get` every 3 s while its tab is open, as the desktop does, until
     the door has a planning stream.
6. **Offline: reads are cached, and only captures queue.**
   - drift keeps the last result of each read the app has shown, keyed by operation and input
     digest, with the time it was read. Screens show it with "as of".
   - New captures are the only writes that queue. Each one has a client idempotency key, so a
     replay can't make two work items.
   - Approvals, answers, messages to agents, releases and edits need a connection. Offline, their
     buttons are disabled with a note.
7. **The phone speaks a door protocol, like the desktop.**
   - Every request sends `x-sf-client: mobile` and `x-sf-client-protocol: <n>`.
   - The engine's `MOBILE_MIN_PROTOCOL` answers `426 update_required` below it, as
     `DESKTOP_MIN_PROTOCOL` does for the desktop.
8. **Install and update.**
   - The app is a signed APK served from the downloads site, `https://downloads.zerobsai.com/android/`,
     with a `canary` and a `stable` channel and a `latest.json` (`versionCode`, `versionName`, `url`,
     `sha256`) per channel.
   - The app checks it every 6 hours and on `update_required`. It downloads the APK, checks its
     SHA-256, and hands it to Android's `PackageInstaller`. Android itself refuses an update signed
     with a different key.
   - The release key lives only in GitHub Actions secrets, in the `release` environment, and in the
     owner's offline backup. A `.github/workflows/mobile-release.yml` job signs and uploads canary
     on merges to `main` that touch `apps/mobile`, and stable on `mobile-v*` tags.
9. **Platform code is ours where security depends on it.** The device key, the fingerprint prompt
   and key attestation are a small Kotlin plugin in `apps/mobile/android` (`DeviceKeyPlugin`), not a
   third-party package ([ADR 0541](0541-phone-devices-keystore-keys-and-fingerprint-proofs.md)).
   Push, speech, sharing and the image picker use maintained Flutter packages (`firebase_messaging`,
   `speech_to_text`, `receive_sharing_intent`, `image_picker`).

## Consequences
- The UI can't be shared with the desktop. The screens are written twice, React and Flutter. What
  can be kept in step is listed in spec 60 ("Keeping behaviour in step"): generated types, shared
  vectors, wording fixtures, and the engine doing the work (summaries, impact, grouping) instead of
  the clients.
- Some pure logic in `packages/client` will be ported to Dart: inbox grouping, the review packet's
  sections, planning question order, the work item steps, formatting. Each port gets the TS tests'
  cases as a JSON fixture, written by a script in `packages/client` and read by a Dart test. Where a
  rule matters for safety, the engine computes it and both clients show its answer.
- Flutter adds a second toolchain to CI. Only the mobile job pays for it.
- Choosing Riverpod and drift is a team convention, not a contract. Swapping one later touches only
  `apps/mobile`.
