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
| `src/bun/operations.ts` | The view's `call`, `batch` and `decide`; an operation that always needs a presence proof is refused through `call`. |
| `src/shared/decisions.ts` | The operations that take a desktop presence proof (`mobile.pairOffer` only through `decide`, `device.update` through either). |
| `src/mainview/` | The SPA (TanStack Router, hash history) on `packages/ui`. It holds no token. |
| `src/mainview/lib/` | `op` / `read` (one `batch` per tick) / `decide`, the queries (`flow-queries.ts` for the new core), the session from `org.list`, Team's wording (`team.ts`). |
| `src/mainview/routes/_app.tsx`, `components/shell-*.tsx` | The window (spec 41, ADR 0460): the toolbar with tabs and ⌘K above the new core's shell, and the keyboard shortcuts. |
| `src/mainview/routes/flow*.tsx`, `components/flow/` | The app (spec 70, `.kim/mockups/`): the org strip and one sidebar; a project's board and list, the item panel and page with its timeline; Team (agents, runners, people); Settings (This Mac, Members); All orgs. Inbox, Chat, Auto (schedules and triggers) and Plugins (with Gateways) too. On the `flow.*` operations; `/` goes here. `packages/ui` `desktop.css` gives it the mockups' tokens under `data-look="flow"`. |
| `src/mainview/lib/view-state.ts` | This Mac's view state: tabs and the chosen org. Never sent to the factory. |
| `screenshots/` | The screenshot harness: the view over a fixture door, shot by Chrome over CDP (`node apps/desktop/screenshots/shoot.mjs --out <dir> [screen ...]`), and the behaviour tests (`behave.mjs`). |

## Looking at real screens (`live.mjs`)
The screenshot harness and the behaviour tests only ever see fixtures, and the installed app's
window can't be driven by an agent. `screenshots/live.mjs` serves the same view in headless Chrome
with the live bridge (`screenshots/live-bridge.ts`): everything about this Mac (the device key, the
updater, the runner card) is the fixture's, but every operation goes to the real engine as the
person the `sf` CLI is signed in as (`sf login`; it reads `~/.config/software-factory/cli.json`,
or `SF_TOKEN` / `SF_URL`). The view posts to the script's own dev server, which forwards to
`/cli/v1/call` and `/cli/v1/batch` and adds the token there: the token never reaches the browser,
the output or a file.

```sh
node apps/desktop/screenshots/live.mjs shots [--out <dir>] [--dark] [route ...]   # PNG of each screen
node apps/desktop/screenshots/live.mjs run <script.mjs>                            # click through a flow
```

- `shots` with no routes walks the org: all orgs, the inbox, each project's board, list, workflow
  and settings, the first items as a panel and a page, the newest run, Chat, Team, Auto, Plugins and
  Settings. Each screen is shot once it settles (no request in flight, no skeleton; 15 s at most).
- `run` calls the script's default export with `go(path)`, `click(testIdOrText)`,
  `type(field, text)`, `press(key)`, `waitForText(text)`, `text(target)`, `shot(name)` and
  `evaluate(js)`: `export default async ({ go, click, shot }) => { await go("/flow/orgs"); … }`.
- **Read-only by default**: a call to any operation the engine's listing (`/cli/v1/ops`) doesn't
  mark `read` is refused before it leaves the script, and reported. `--write` allows writes; this is
  the owner's real data.
- For every route it prints console errors, failed requests and failed operations (name and
  message), and exits 1 if there were any: a screen can render while an operation behind it fails.
- **The images hold real data and the repo is public**: they go to a new directory in the OS temp
  dir (printed). `--out` picks another; one inside the repo must be git-ignored. Never commit them.
- `SF_LIVE_PORT` moves its server off 5781. It's a manual tool (it needs a signed-in CLI and the
  engine), never a CI job.

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
any of them can drive the app's own `bun`. So the token is only "this Mac, this user". Adding a phone
and turning on a device's approvals need a presence proof the device key signs after Touch ID (ADR 0391). An unsigned build has no
Secure Enclave key; it uses a software key and the website shows that when you approve it.
