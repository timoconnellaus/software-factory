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
| S | — | 0100–0199 | Spikes under `spikes/`. Each spike takes the next free ten and notes it here. Taken: **0100–0109** `spike-runner-orca` (ADR 0100, runner contract, in `spikes/runner-orca/`); **0110–0119** `spike-workflow-gate` (ADR 0110, Workflow per work item and the gate, `spikes/workflow-gate/adr/`); **0120–0129** `spike-auth-multisession` (ADR 0120, auth, orgs and multiple accounts, `spikes/auth-multisession/docs/`). **0130–0139** `spike-electrobun` (ADR 0130, the desktop app on Electrobun, `spikes/electrobun/docs/`). The proposed ADRs move to `docs/adr/` when a spec promotes the spike. | merged (spikes); 0130–0139 in progress; 0140–0199 free |
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
| V | 0150–0159 | 0380–0389 | Run agents on hosts without Orca (`no-orca`): the plan, spec 30 (runner-local, tmux, hook status, delete runner-orca) and the later pieces' specs. Used: ADR 0380, no migrations | in progress |
| W | 0160–0169 | 0390–0399 | The desktop app (`desktop-app`): spec 40. ADR 0130 promoted, the client door and desktop devices with presence proofs, `apps/desktop` on Electrobun, the website shrinks to auth | in progress |
| X | 0170–0179 | 0400–0409 | Watch and steer runs from the dashboard (`hosts-watch-steer`): spec 31. Used: migration 0170; ADR 0400 | in progress |
| Y | 0180–0189 | 0410–0419 | Claude accounts on a host (`hosts-accounts`): spec 32, plan piece 3. Accounts on the host, manual switching from the host or the dashboard (`runner.account.use`), the account in the harness launch. Used: migration 0180; ADR 0410 | in progress |
| Z | 0190–0199 | 0420–0429 | Linux hosts (`hosts-linux`): spec 34. The systemd user service, platform paths, the harness sandbox on Linux, Linux doctor checks, the install path. Used: ADR 0420, no migrations | in progress |
| AA | 0200–0209 | 0430–0439 | Container per job (`hosts-containers`): spec 33, hosts plan piece 4. Used: ADR 0430, no migrations | in review |
| AB | 0210–0219 | 0440–0449 | Web terminal in the dashboard (`hosts-web-terminal`): spec 35. The TerminalRelay Durable Object per job, the `terminal` held call and host socket, `run.terminal.*`, the tmux control-mode bridge, the Live tab's web terminal. Used: migration 0210; ADR 0440 | in progress |
| AC | 0220–0229 | 0450–0459 | Chat UI on a stream-json session (`hosts-chat-ui`): spec 37. Used: migration 0220; ADR 0450 | in progress |
| AL | 0310–0319 | 0540–0549 | The phone app (`mobile-app`): spec 60, Android first in Flutter. Design: ADRs 0540–0543 (the app, phone devices and fingerprint proofs, push through FCM, policy approval on the phone). PR 1a (`mobile-server`): migration 0310 (phone devices, pair offers, `mobile` tokens); ADR 0541 amended (#91, merged). Follow-up (`mobile-server-followup`): migration 0311 (pair offer indexes, the nonce ask table dropped for a rate limiting binding); ADR 0541 amended | in review |
| AD | 0230–0239 | 0460–0469 | The desktop shell and look (`desktop-shell`): spec 41, slice 1 of the approved UI design. The window shell, the look as `packages/ui` tokens, the existing screens restyled. Used: ADR 0460, no migrations | in progress |
| AK | 0300–0309 | 0530–0539 | The desktop terminal (`desktop-terminal`): spec 42. Open terminal opens the session's web terminal in the desktop app through the client door. Used: ADR 0530, no migrations | in progress |
| AE | 0240–0249 | 0470–0479 | Planning to kim's standard (`planning`): the [audit against kim](reviews/2026-11-12-planning-against-kim.md), spec 20's fixes, then specs 21, 23, 22, 24 | in progress |
| AG | 0260–0269 | 0490–0499 | Projects, repositories, backlog and release (`work-model`): spec 50. A project has repositories (migration 0260, ADR 0490); backlog, ready, queued, `workItem.release`, waits-for links and the pull (migration 0261, ADR 0491); a project runs one workflow (ADR 0492); shaping stages run before release (migration 0262, ADR 0493) | in progress |
| AF | 0250–0259 | 0480–0489 | Sprites sandboxes (`hosts-sprites`): spec 36, hosts plan piece 7. A sprite per job, provisioned by the owner's runner host. Used: ADR 0480, no migrations | in review |
| AG | 0260–0269 | 0490–0499 | Projects, repositories, backlog and release (`work-model`): spec 50. A project has repositories (migration 0260, ADR 0490); backlog, ready, queued, `workItem.release`, waits-for links and the pull (migration 0261, ADR 0491); a project runs one workflow (ADR 0492) | in progress |
| AI | 0280–0289 | 0510–0519 | Workflows from stage types (`workflow-design`, then `spec-52-*` branches): spec 52 with the owner's answers. ADRs 0510–0516 (stage types and org workflows, the reconciler, the review packet, skills, autopilots, dark factory mode, the classifier as an allow-list); migrations 0280 (org configs, used), 0281 (reconciler shadow, used), 0282 (projects on org workflows, used), 0285 (release flag, used), 0283 (skills), 0284 (autopilots) planned | building |
| AH | 0270–0279 | 0500–0509 | Verify from the factory's own evidence (`verify-evidence`): spec 51. PR A, the tests-intact guard (ADR 0500, no migrations); PR B, checks run by the runner host, proven criteria (ADR 0501, migrations 0270–0272). | in progress |
| AM | 0320–0329 | 0550–0559 | Runners under load (`runner-tmux-robust`): spec 43, incident #11. No orphans, tmux errors aren't "gone", back off claiming under load, marked run branches. Used: migration 0320; ADRs 0550–0552 | in review |
| AJ | 0290–0299 | 0520–0529 | Runner updates without draining on every deploy (`runner-update-no-drain`): spec 38 (keep claiming while an update is pending, the caps, `minRunnerCompat`, `RUNNER_SHA` from the deploy) and spec 39 (re-adopting live jobs after a restart, spec only). Used: migration 0290 (`core_runners.compat`); ADR 0520 | in review |
| AQ | 0360–0369 | 0590–0599 | Cloudflare cost (`cf-cost`): the cost audit's fixes and the [rules](../AGENTS.md#cloudflare-cost). PR 1 indexes and quick wins (migration 0360); spec 44 PR 1, held calls poll in the Worker (0367, 0368); the job line (ADR 0592); PR 2 the audit journal (ADR 0590); PR 3 retention of tables that only grow; PR 4 `job.claim` in one query; a spec for Durable Objects held awake | in progress |
| AP | 0350–0359 | 0580–0589 | The babysitter (`babysitter`): spec 53. Approval separated from delivery, stop the line on red main, approval across a clean merge of main, the `babysit` job, red-main repair. ADRs 0580–0585, 0587 (a person's push re-verifies, Workflow v14); Workflow v11 (provisional: next free at merge); migrations 0350 delivery, 0351 main health, 0352 approved change, 0353 flakes | in progress |
| AR | 0370–0379 | 0600–0609 | Planning to kim's standard, continued (`planning`, block AE ran out above the 0261 rebuild of `core_work_items`): spec 23's parked items (`core_work_items.needs_info`) and what follows. Used: migrations 0370 (`needs_info`), 0371 (`core_work_items_project_title_idx`), 0372 (`core_specs.critique`) | in progress |
| AS | 0380–0389 | 0610–0619 | The website shrinks to sign-in (`web-shrink`): spec 40 M5 brought forward, policy screens and decisions move to the desktop. Used: ADR 0610 | in progress |
| AT | 0390–0399 | 0620–0629 | The babysitter, continued (`babysitter`, block AP's migrations sort before 0363 and 0373, which `core_jobs`' rebuild must follow): spec 53 parts d and e. The `babysit` job kind (migration 0390: `core_jobs` rebuilt once with no stage CHECK, the delivery fence, `core_flakes`; 0391 red-main attribution), red-main repair | in progress |

Add more blocks of ten as needed. Once `packages/db` has a schema version constant, it equals the
highest migration on `main`; when you merge `main`, keep the larger value.

## Workflow versions
Workflow versions are not claimed in blocks. The work-item Workflow keeps one table,
`WORKFLOW_FEATURES`, mapping each version to the set of features it has; code asks
`has(version, "feature")` and never compares `version >= N` (a later PR's check would switch on
inside running instances of an earlier version). A PR that changes the Workflow's steps takes the
next number above whatever is on `main` **at merge time** and adds its row; a merged row is never
edited. Rows in other open PRs don't exist until they merge, so renumber when you merge `main`.

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
