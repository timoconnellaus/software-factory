# Spike: the factory desktop app on Electrobun

Goal: before writing the spec, check the parts of the [desktop app plan](../../.kim/plans/2026-11-11-software-factory-desktop-app-electrobun.md)
where Electrobun or macOS could surprise us. Proposed decision: [ADR 0130](docs/0130-desktop-app-on-electrobun.md).

This is a standalone package and isn't in the workspace or Biome (`spikes/**`). Throwaway.

```sh
export PATH="$HOME/.hutch/bin:$PATH"   # Hutch, Electrobun 2.x's toolchain (installed on first use)
pnpm install --ignore-workspace
pnpm vendor:node && pnpm build:runner  # vendor/node (Node 24) + vendor/sf-runner.mjs (the real runner host)
scripts/run.sh                         # build the dev env and run it from the bundle
SF_SPIKE_SELFTEST=/tmp/st.jsonl scripts/run.sh   # the app exercises every check and writes evidence
```

`probe/read-token.ts` is run by *another* process to see whether it can read the app's token.

## Layout

| Path | What |
| --- | --- |
| `electrobun.config.ts`, `hutch.config.ts` | The app: `sf-spike://` scheme, `exitOnLastWindowClosed: false`, the Node and runner copied into `Resources/app/runner/`. |
| `src/bun/index.ts` | Main process (Bun): window, menu-bar `Tray`, RPC handlers, `open-url`, `before-quit`. |
| `src/bun/supervisor.ts` | The runner as a child on the bundled Node 24: restart with backoff, clean stop, a scrubbed env. |
| `src/bun/keychain.ts`, `cf.ts` | The desktop token through Security.framework over `bun:ffi` (login keychain and data-protection keychain). |
| `src/bun/dock.ts` | Dock badge through the Objective-C runtime (no Electrobun API). |
| `src/bun/selftest.ts` | `SF_SPIKE_SELFTEST`: runs each check and writes JSON lines. |
| `src/mainview/` | A TanStack Router (hash history) + Query SPA on `packages/ui`, talking to Bun over Electrobun RPC. |
| `fake-runner/runner.mjs` | Stand-in runner (heartbeats, crashes on request) for supervision tests. |

## Results (this Mac, 2026-11-12: Electrobun 2.0.6, Hutch 0.29.0, Bun 1.4.4 in the app, Node 24.21.0)

| Check | Result |
| --- | --- |
| Builds next to pnpm/Turborepo, Bun only for the app | **Works, with a catch.** Electrobun 2.x isn't an npm SDK any more: the `electrobun` npm package only bootstraps **Hutch**, which downloads the SDK into `.hutch/devkit` (`electrobun/main`, `electrobun/view` are path aliases into it) and does the build. Hutch installs itself to `~/.hutch` and **adds a PATH line to `~/.zshrc`**. pnpm still owns `node_modules`; Vite builds the view. CI needs Hutch (macOS runner) and the devkit cache. |
| SPA from `packages/ui` in WKWebView, RPC to Bun | **Works.** `packages/ui` from source via Vite aliases, `dedupe: react`; tsc needs `paths` for React types (packages/ui has its own copy). Hash history (`views://` has no server). View → Bun requests and Bun → view messages both work (heartbeats stream into the page). |
| Supervised Node 24 child | **Works.** The real `sf-runner` bundles to one 880 KB ESM file and runs on the vendored Node (`status`). Crash → restart with a new pid in ~1 s. Closing the window keeps the app and runner up. Quit stops the runner. |
| `sf-spike://` deep link | **Works** once the .app is in `/Applications` (Electrobun's doc says so). Warm: `open-url` fires and the SPA routes to `#/work/42`. Cold start: `open-url` fires ~80 ms after launch, before the view listens; Bun holds it and the view pulls it on mount. |
| Menu bar, notification, dock badge | **Works.** `Tray` with title + menu. `Utils.showNotification` works but is fire-and-forget (no click callback; unsigned it falls back to the legacy API after a UNErrorDomain auth error). No dock-badge API: done through `objc_msgSend` + `performSelectorOnMainThread`. |
| **Keychain item only the app can read** | **Fails. This is the blocker for token-only gate decisions.** See below. |

### The Keychain result
The app stores the token with `SecItemAdd` from its main process. That process is `Contents/MacOS/bun`
running `Resources/main.js`, spawned by a native `launcher`.

1. **The app's own `bun`, run from a shell with a foreign script, reads the token silently**
   (`"SF Spike-dev.app/Contents/MacOS/bun" probe/read-token.ts` → status 0, the token). The Keychain
   trusts a code signature, and the trusted code here is a general-purpose interpreter. A Developer ID
   signature doesn't change that, since it's the same binary. Hardened runtime doesn't either, because
   bun reads the script as data.
2. **Unsigned (ad-hoc) builds are worse:** Homebrew's bun, an unrelated binary, also read it silently.
   Ad-hoc-signed processes share the `unsigned:` partition.
3. Apple's `security find-generic-password -w` blocked on a system prompt (killed after 12 s).
4. The data-protection keychain (`kSecUseDataProtectionKeychain`) returns `-34018`
   (errSecMissingEntitlement) without a Team ID `keychain-access-groups` entitlement. With one, the
   check is still against the *process's* signature, which is the same `bun`, so (1) still applies.

So on one user account, anything that can run a program can make the app's main process do what it
can do, including Claude in an Orca terminal or a harness. A token in the Keychain proves "this Mac,
this user" but not "a person did this". **Only an OS-mediated presence check proves that:** Touch ID
or the login password through LocalAuthentication, ideally a Secure Enclave key created with
`.userPresence` that signs each decision, which no script can make without the person.

Not tested: whether Claude Code's own sandbox (seatbelt) blocks the `securityd` lookup. Builds also
run outside it (the owner's own sessions), so that wouldn't change the answer.

### Other findings
- **Killing the `launcher` orphans the app.** Its `bun` child and the runner's Node keep running.
  Repeated test runs left five copies, each with its own runner. Two hosts with one runner identity
  would fight over leases. The app needs a single-instance lock and a runner pidfile/lock
  (`sf-runner` should refuse to start twice), and the supervisor should die with its parent.
- **Size:** 209 MB installed (Node 116 MB, Bun 85 MB). The canary update is a 61 MB `.tar.zst`.
  Canary/stable builds ship as a **self-extracting** stub (`launcher` + archive) that unpacks over
  itself on first run and writes an uninstaller to `~/Library/Application Support/<id>/<channel>/`.
  Notarization has to be checked against that, since the bundle changes after the first launch.
- **No login-item API** in Electrobun 2.0.6. Use `SMAppService` through FFI or a LaunchAgent plist.
- No Developer ID identity on this Mac (`security find-identity -v -p codesigning`: 0), so signing,
  notarization and updates weren't tried, as planned.

## Left on this machine
- `/Applications/SF Spike-dev.app` (for the URL scheme). Remove it when done.
- `~/.hutch` and the `# Hutch` PATH line in `~/.zshrc`.
- `~/Library/Application Support/dev.software-factory.spike/`.
- The test Keychain item was deleted (`probe/delete-token.ts`).
