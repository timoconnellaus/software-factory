# @software-factory/app → Worker `sf-app`

The dashboard: TanStack Start + shadcn/ui (`packages/ui`) on Workers, GitHub sign-in with Better
Auth, and server functions that call operations on `sf-engine` (`EngineApi`, ADR 0051, 0240).

| Route | Screen |
| --- | --- |
| `/sign-in` | Continue with GitHub (allowlisted logins only) |
| `/` | Inbox: gates and questions waiting on you, grouped by project; Running; runner health. `/?item=<id>` highlights a card |
| `/new` | New work: the box, the project picker and the routing preview (`workItem.previewRouting`) |
| `/work` | Every work item |
| `/work/<id>` | Detail: stage steps, Timeline (audit journal), Planning (questions + living spec + Approve spec), Runs, Review packet |
| `/work/<id>/review` | The review packet: the merge gate (Merge / Send back) |
| `/setup` | Add the project, sync `.factory/policy.json`, register runners (key shown once) |

- `src/server/` runs on the Worker: `auth.ts` (Better Auth on `core_*`, allowlist, Personal org),
  `app-api.ts` (what the server functions do, tested in workerd), `fns.ts` (the server functions).
- `src/lib/ops.ts` types every operation the app calls from core's zod schemas; `op()` in
  `src/lib/op.ts` is the typed client. Pages never touch D1.

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
