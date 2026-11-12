# @software-factory/desktop

The desktop app ([ADR 0380](../../docs/adr/0380-the-desktop-app-is-the-daily-ui.md),
[spec 40](../../docs/specs/40-desktop-app.md)): the daily factory UI on macOS (Apple Silicon), built
on Electrobun 2.x. It supervises this Mac's `sf-runner` and calls operations through sf-engine's
client door with a desktop token ([ADR 0381](../../docs/adr/0381-the-client-door-desktop-devices-and-presence.md)).

```sh
pnpm --filter @software-factory/desktop devkit      # fetch the Electrobun SDK (Hutch) into .hutch/
pnpm --filter @software-factory/desktop typecheck
pnpm --filter @software-factory/desktop test        # Node: deep links, PKCE, the door client, backoff
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
| `src/bun/device-key.ts`, `native/sf-keys.swift` | The device key: Secure Enclave (with `.userPresence`) on a signed build, else a declared software key. |
| `src/bun/keychain.ts`, `cf.ts`, `macos.ts` | Keychain secrets, dock badge and login item over `bun:ffi`. |
| `src/bun/runner.ts`, `backoff.ts` | `sf-runner run` on the bundled Node 24: restarts, launchd takeover, pairing. |
| `src/bun/instance.ts` | One app per user, and quitting (with the runner) if the launcher dies. |
| `src/mainview/` | The SPA (TanStack Router, hash history) on `packages/ui`. It holds no token. |

## Signing the key helper (M4)
Only `sf-keys` gets the `keychain-access-groups` entitlement (the Developer ID team's group), so only
it can use the Secure Enclave key. The app's `bun` must not have it: any process of the user can run
that binary with its own script. `sf-keys` signs only presence messages, and the Touch ID prompt
shows their engine-written summary (ADR 0381).

## What isn't proof
The Keychain doesn't keep the desktop token from other processes of the same user: the spike showed
any of them can drive the app's own `bun`. So the token is only "this Mac, this user". Gate decisions
need a presence proof the device key signs after Touch ID (ADR 0381). An unsigned build has no
Secure Enclave key; it uses a software key and the website shows that when you approve it.
