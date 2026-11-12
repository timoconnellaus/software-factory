# Parallel work

How several sessions build the factory at the same time without stepping on each other. Read
[`handoff.md`](handoff.md) first.

## Claim a range before you start
Every build that may add a migration or an ADR claims a block of numbers here, in its **first
commit**, by editing this table. Use the next free block. Unused numbers in a block are fine.

| Block | Migrations | ADRs | Claimed by | Status |
| --- | --- | --- | --- | --- |
| A | 0001–0009 | 0001–0099 | Scaffold + docs (`scaffold-and-docs`): ADRs 0001–0032 used, no migrations | merged |
| A2 | — | 0033–0049 | Review decisions (`review-decisions-docs`): ADRs 0033–0047, no migrations | merged |
| S | — | 0100–0199 | Spikes under `spikes/`. Each spike takes the next free ten and notes it here. Taken: **0100–0109** `spike-runner-orca` (ADR 0100, runner contract, in `spikes/runner-orca/`); **0110–0119** `spike-workflow-gate` (ADR 0110, Workflow per work item and the gate, `spikes/workflow-gate/adr/`); **0120–0129** `spike-auth-multisession` (ADR 0120, auth, orgs and multiple accounts, `spikes/auth-multisession/docs/`). The proposed ADRs move to `docs/adr/` when a spec promotes the spike. | merged (spikes); 0130–0199 free |
| B+C+D | 0010–0039 | 0050–0059 | V1 step 1, core + engine (`v1-core-engine`): specs 01, 02 and the cloud half of 03 (schema, operations, Workflow, runner channel, job tokens). Also promotes spike ADRs 0100 and 0110 into `docs/adr/`. Used: migrations 0010, 0020, 0030; ADRs 0050–0054 | merged |
| E | 0040–0049 | 0230–0239 | V1 step 4, verify + GitHub connector + incidents (`v1-verify-connector`): spec 04, the webhook connector, `factory/verify`, review-packet assembly, incidents, evals. Used: migration 0040; ADRs 0230, 0231 | merged |
| F | 0050–0059 | 0240–0249 | V1 step 2, the app (`v1-app`): `apps/app` (TanStack Start + shadcn), `packages/ui`, Better Auth sign-in, Inbox, New work, work item detail + Planning, review packet. Used: ADR 0240, no migrations. App performance (`app-tanstack-perf`): ADR 0241 | merged |
| G | — | 0250–0259 | V1 step 3, the runner (`v1-runner`): `local/runner-host`, `runner-orca`, `harness-claude`. Used: ADR 0250, no migrations | merged |
| H | 0060–0069 | 0055–0059 | Onboarding (`onboarding-connect-github`): Connect GitHub (installation records), repo picker, policy auto-sync and the policy PR, runner device login, the Setup checklist. Used: migration 0060; ADRs 0055, 0056 | merged |
| I | — | 0260–0269 | Runner resolves the existing Orca repo (`runner-orca-resolve-repo`): incident 2026-11-11 #5. Used: ADR 0260, no migrations | merged |
| J | — | 0270–0279 | The factory sets Claude's permission mode and sandbox (`harness-permission-mode`): incident 2026-11-11 #6. Used: ADR 0270, no migrations | merged |
| K | 0070–0079 | 0280–0289 | Protect `main` (`protect-main-ruleset`): the default-branch ruleset generator, the Setup step, drift detection. Used: migration 0070; ADR 0280 | merged |
| L | 0080–0089 | 0290–0299 | Attach an outside PR (`attach-pr`): spec 05, `workItem.attachPr`, the Workflow's attached path, `/attach`. Used: migration 0080; ADR 0290 | merged |
| M | — | 0300–0309 | Planning design (`planning-process`): ADRs 0300–0306, specs 20–25, no migrations (spec 20's build claims its own block) | merged |
| N | 0090–0099 | 0310–0319 | Work item attachments (`wi-1-attachments`, work item 1): R2 blobs, `workItem.attachment.*`, upload and serving routes, the runner channel's attachment calls, the app's Attachments section. Used: migration 0090; ADR 0310 | merged |
| P | 0100–0109 | 0330–0339 | The merge queue (`merge-queue`): spec 06, `core_merge_queue`, `mergeQueue.*`, Workflow v5. Used: migration 0100; ADR 0330 | merged |
| Q | 0110–0119 | 0340–0349 | The `sf` CLI (`cli`): spec 07, browser-only gate operations, CLI device login and tokens, `/cli/v1`, `local/cli`. Used: migration 0110; ADR 0340 | in review |
| O | — | 0320–0329 | Unmergeable factory PRs (`stuck-work-item`): incident 2026-11-11 #7. Branches merge the default branch before build, `conflict` is its own verify state, missing CI asks a person instead of retrying the build | merged |
| R | 0120–0129 | 0350–0359 | Planning M1, the loop (`planning-loop`): spec 20. The planning session on a runner, the planning MCP server and hooks, the planning log, chat, presence, heavy and light pools, Workflow v5, the Planning tab (layout A). Used: migration 0120; ADR 0350 | merged (#33, #35, #36, #37) |
| U | 0140–0149 | 0370–0379 | Factory config in the app (`manage-the-factory-sttings-in-the-ui`): spec 09 (M1 config versions + Settings, M2 workflows + agents, M3 usage + improver, M4 adjudicator). ADRs 0370–0374; migrations 0140 (M1), 0141 (M2), 0142 (M3), 0143 (M4) | building |
| T | 0130–0139 | 0360–0369 | Runners update themselves (`runner-auto-update`): spec 08, `DEPLOYED_SHA`, heartbeat versions, the self-updater and its rollback wrapper, `sf-runner install` fixes (incident #9). Used: migration 0130; ADR 0360 | in review |

Add more blocks of ten as needed. Once `packages/db` has a schema version constant, it equals the
highest migration on `main`; when you merge `main`, keep the larger value.

## Reserved areas
Avoid these unless your build is the one named, because another build is changing them:

| Area | Reserved for |
| --- | --- |
| `spikes/**` | The spike sessions. Not part of the workspace or Biome. |
| `docs/research/`, `docs/ui-plan.md`, `.kim/` | The design sessions. |

Remove a row when its build merges.

## Shared files that always conflict
Resolve by keeping both sides, then regenerate where noted:
- the operations registry and `packages/core/package.json` exports;
- `pnpm-lock.yaml` (run `pnpm i` after merging);
- `worker-configuration.d.ts` (`wrangler types`);
- `routeTree.gen.ts` once `apps/app` is TanStack Start (regenerated by `vite dev` or the build);
- `CONTEXT.md`, `docs/architecture.md`, `docs/adr/README.md`, `docs/specs/README.md`, this file and `handoff.md`.

## Local limits
- One shared Mac. Run only the tests you touched; `pnpm test --concurrency=2`.
- Use your own port for any dev server. Never stop or kill a process you didn't start.

## Finishing
Merge `origin/main` into your branch with a merge commit, keep both sides, run lint, typecheck and
the affected tests, push, open a PR, then hand back. Release your block here when you merge.
