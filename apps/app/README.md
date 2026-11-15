# @software-factory/app → Worker `sf-app`

The website, and only for signing in: TanStack Start + shadcn/ui (`packages/ui`) on Workers,
GitHub sign-in with Better Auth, the pages that approve other devices' sign-ins, and the GitHub
App's Setup URL. Everything else is in the desktop app. Operations run on `sf-engine`
(`EngineApi`, ADR 0051).

| Route | What |
| --- | --- |
| `/sign-in` | Continue with GitHub (allowlisted logins only) |
| `/` | "Signed in": says to use the desktop app, and how connecting GitHub went |
| `/cli/connect` | Approve an `sf login` code (`cli.deviceLookup`, `cli.approveDevice`, `cli.denyDevice`) |
| `/desktop/connect` | Approve the desktop app's sign-in (`desktop.authLookup`, `.approveDevice`, `.denyDevice`) |
| `/runners/connect` | Approve an `sf-runner login` code (`runner.deviceLookup`, `.approveDevice`, `.denyDevice`) |
| `/mobile/connect` | Approve a phone's sign-in (`mobile.authLookup`, `.approveDevice`, `.denyDevice`) |
| `/mobile/callback`, `/mobile/pair` | Bounce to the phone app when its App Link didn't open it |
| `/integrations/github/setup` | The GitHub App's Setup URL: `github.connectInstallation`, then `/` |
| `/.well-known/assetlinks.json` | The phone app's App Links statement |

- `src/server/` runs on the Worker: `auth.ts` (Better Auth on `core_*`, allowlist, Personal org),
  `app-api.ts` (what the server functions do, tested in workerd), `fns.ts` (the server functions),
  `github-setup.ts` (the Setup URL).
- `src/lib/ops.ts` is the allowlist of operations the server function forwards; `op()` in
  `src/lib/op.ts` is the typed client. Pages never touch D1. Server functions send
  `Server-Timing` (`auth`, `opN`, `engineN`).

## Develop
```sh
cp .dev.vars.example .dev.vars   # BETTER_AUTH_SECRET etc. (gitignored)
(cd ../engine && pnpm exec wrangler d1 migrations apply software-factory --local --persist-to ../app/.wrangler/state)
pnpm dev                          # http://localhost:5180, runs sf-engine alongside (GITHUB_FAKE=1)
```
GitHub sign-in needs the production callback URL, so locally you sign in by creating a
`core_session` row and setting the signed `better-auth.session_token` cookie (see
`test/helpers.ts` for the signing).

`pnpm build` is `vite build`; `wrangler deploy` then uploads `dist/` (the deploy workflow runs both).
