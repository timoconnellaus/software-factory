# @software-factory/desktop

The desktop app ([ADR 0390](../../docs/adr/0390-the-desktop-app-is-the-daily-ui.md),
[spec 40](../../docs/specs/40-desktop-app.md)): the daily factory UI on macOS (Apple Silicon), built
on Electrobun 2.x. It supervises this Mac's `sf-runner` and calls operations through sf-engine's
client door with a desktop token ([ADR 0391](../../docs/adr/0391-the-client-door-desktop-devices-and-presence.md)).

```sh
pnpm --filter @software-factory/desktop devkit      # fetch the Electrobun SDK (Hutch) into .hutch/
pnpm --filter @software-factory/desktop typecheck
pnpm --filter @software-factory/desktop test        # Node: the door client, decisions, loaders, the timeline
pnpm --filter @software-factory/desktop dev         # macOS: build the dev .app and run it here
SF_ENGINE_URL=http://localhost:8787 pnpm --filter @software-factory/desktop dev   # against a local engine
```

`bundle` (macOS only, outside turbo's `build`) compiles the Secure Enclave helper (`swiftc`), copies
Node 24 and bundles `sf-runner` into `vendor/`, then has Electrobun build the `.app`. Hutch installs
itself to `~/.hutch` and adds a PATH line to your shell profile the first time.

## Layout
| Path | What |
| --- | --- |
| `src/bun/index.ts` | Main process: window, menu bar, RPC, `sf://` links, inbox count, notifications, badge. |
| `src/bun/door.ts` | The client door client; `decide()` is the presence flow (challenge → Touch ID → call). |
| `src/bun/auth.ts`, `pkce.ts` | Browser sign-in: device key, PKCE, `/desktop/connect`, `sf://auth/callback`, exchange. |
| `src/bun/device-key.ts`, `native/sf-keys-app` | The device key: Secure Enclave (with `.userPresence`) through `SF Keys.app` on a release with the helper, else a declared software key. |
| `src/bun/keychain.ts`, `cf.ts`, `macos.ts` | Keychain secrets, dock badge and login item over `bun:ffi`. |
| `src/bun/runner.ts`, `backoff.ts` | `sf-runner run` on the bundled Node 24: restarts, launchd takeover, pairing. |
| `src/bun/instance.ts` | One app per user, and quitting (with the runner) if the launcher dies. |
| `src/bun/operations.ts` | The view's `call`, `batch` and `decide`; a gate decision through `call` is refused. |
| `src/bun/save.ts` | Saving a file the view hands over (a ruleset, an attachment) to ~/Downloads. |
| `src/shared/decisions.ts` | The gate decisions, which go only through `decide` (Touch ID). |
| `src/mainview/` | The SPA (TanStack Router, hash history) on `packages/ui`. It holds no token. |
| `src/mainview/lib/` | `op` / `read` (one `batch` per tick) / `decide`, the queries, the session from `org.list`, decisions, attachments over the door. |
| `src/mainview/routes/`, `components/` | The screens (spec 40 M3, restyled for spec 41): Inbox, Work, New work, attach, the work item (Overview, Plan, Runs, Review, Activity), Setup, This Mac. Pure logic is in `packages/client`. |
| `src/mainview/routes/_app.tsx`, `components/shell-*.tsx` | The window shell (spec 41, ADR 0460): toolbar with tabs and ⌘K, org rail, sidebar, the content panel, status bar, keyboard shortcuts, focus mode. Sections (`_work.tsx`, `_settings.tsx`) are layout routes with their nested list. |
| `src/mainview/lib/view-state.ts` | This Mac's view state: tabs, pins, the chosen org, the sidebar, focus. Never sent to the factory. |
| `screenshots/` | The screenshot harness: the view over a fixture door, shot by Chrome over CDP. `node apps/desktop/screenshots/shoot.mjs --design` writes `docs/screenshots/desktop-shell/`. |

## Releases (M4)
Signed, notarized builds come from `.github/workflows/desktop-release.yml`: canary on every merge to
`main` that touches the app or what it bundles; stable is off until the owner locks the `release`
environment down (`docs/deploying.md`), and then is a manual run on `main`, never a tag. The app
applies only a higher version signed by its own Team ID and accepted by Gatekeeper
(`src/bun/updates.ts`, `src/bun/update-verify.ts`), and waits for the runner's jobs before
restarting. Install once from
`https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip` (unzip, move to
`/Applications`, open; there's no installer step); after that the app updates itself (menu bar: *Restart to update*). Electrobun signs and notarizes itself (`mac.codesign`/`notarize`
in `electrobun.config.ts`). It has to: it writes the build hash into `Resources/version.json` after
every hook that could sign, and a file changed after signing makes macOS call the app "damaged". The
build switches on with `ELECTROBUN_DEVELOPER_ID` (plus `ELECTROBUN_TEAMID`, `ELECTROBUN_APPLEAPIKEY`,
`ELECTROBUN_APPLEAPIISSUER`, `ELECTROBUN_APPLEAPIKEYPATH` to notarize), so local builds stay
unsigned. On a Mac with the Developer ID in its keychain:
`ELECTROBUN_DEVELOPER_ID="Developer ID Application: …" ELECTROBUN_TEAMID=… pnpm bundle:canary`.
The download zip is the plain app from the update archive (`scripts/hook-post-package.ts`), not
Electrobun's self-extracting wrapper: the wrapper's Setup window waits for a click, fails when run
translocated from Downloads, and rewrites its own bundle. Nothing writes inside the bundle at run
time; the app's state lives in `~/Library/Application Support/com.software-factory.desktop`.

## Signing the key helper (M4b)
`SF Keys.app` (`native/sf-keys-app`, ADR 0394) is the only code signed with the
`keychain-access-groups` entitlement (the Developer ID team's group, authorised by its embedded
provisioning profile), so only it can use the Secure Enclave key. The app's `bun` must not have it:
any process of the user can run that binary with its own script. Electrobun re-signs nested code
with the app's entitlements, so the postPackage hook (`scripts/keys-helper.ts`) adds the helper at
`Contents/Helpers` afterwards, signs it, re-signs the outer seal and notarizes again. The helper
signs only presence messages, and the Touch ID prompt shows their engine-written summary
(ADR 0391). Releases without `MACOS_KEYS_PROFILE` ship without it, and the app uses a software key.

## What isn't proof
The Keychain doesn't keep the desktop token from other processes of the same user: the spike showed
any of them can drive the app's own `bun`. So the token is only "this Mac, this user". Gate decisions
need a presence proof the device key signs after Touch ID (ADR 0391). An unsigned build has no
Secure Enclave key; it uses a software key and the website shows that when you approve it.
