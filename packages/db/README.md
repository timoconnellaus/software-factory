# @software-factory/db

The `core_*` schema (plain SQL in [`migrations/`](migrations/), applied by `wrangler d1 migrations
apply` from `apps/engine` and by `applyD1Migrations` in tests) and typed access through Kysely
(ADR 0050). Nothing writes these tables except operations in `packages/core` (and Better Auth, its
own tables).

```ts
import { createDb, toStatement, guardChanged, SCHEMA_VERSION } from "@software-factory/db";
const db = createDb(env.DB);            // typed reads
d1.batch([toStatement(env.DB, db.updateTable(...)), guardChanged(env.DB, "name"), ...]);
```

## Tables
| Migration | Tables |
| --- | --- |
| 0010 | `core_meta`, Better Auth (`core_user`, `core_session`, `core_account`, `core_verification`, `core_organization`, `core_member`, `core_invitation`), `core_factories`, `core_projects`, `core_project_policies`, `core_kill_switches`, `core_batch_guard` |
| 0020 | `core_work_items`, `core_intake_keys`, `core_intake_events`, `core_stages`, `core_questions`, `core_specs`, `core_pending_actions`, `core_review_packets`, `core_incidents`, `core_audit` (append-only), `core_outbox` |
| 0030 | `core_runners`, `core_runner_shares`, `core_jobs`, `core_runs`, `core_run_events`, `core_artifacts`, `core_leases`, `core_channel_requests` |
| 0040 | `core_connector_events` (webhook delivery dedupe), `core_verify_checks` (`factory/verify` per head SHA); `core_incidents.root_cause`, `proposed_fix` |
| 0170 | `core_run_steers` (a person's messages into a live run, ADR 0400) |
| 0260 | `core_repositories` (a project's GitHub repositories, ADR 0490; backfilled one per project, whose repo columns are dropped); `core_work_items.repository_id` |
| 0261 | `core_work_items` rebuilt: statuses `backlog`, `planning`, `ready`, `queued`; `priority`, `rank`, `acceptance_criteria`, `released_at`, `released_by`, `pulled_at`; `core_work_item_links` (waits for) (ADR 0491) |

`SCHEMA_VERSION` equals the highest migration on this branch (40). Parallel builds number their
migrations from the block they claim in `docs/parallel-work.md`.

## Better Auth mapping (for the app session)
Better Auth 1.7 with the organization plugin. Set `modelName` and map every camelCase field to its
snake_case column:

| Better Auth model | `modelName` | Fields → columns |
| --- | --- | --- |
| user | `core_user` | `emailVerified` → `email_verified`, `createdAt` → `created_at`, `updatedAt` → `updated_at` |
| session | `core_session` | `userId` → `user_id`, `expiresAt` → `expires_at`, `ipAddress` → `ip_address`, `userAgent` → `user_agent`, `activeOrganizationId` → `active_organization_id`, timestamps |
| account | `core_account` | `userId`, `accountId`, `providerId`, `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt` → snake_case; timestamps |
| verification | `core_verification` | `expiresAt` → `expires_at`, timestamps |
| organization | `core_organization` | `createdAt` → `created_at` (also `kind`: `personal` / `team` / `client`, and `github_installation_id`) |
| member | `core_member` | `organizationId` → `organization_id`, `userId` → `user_id`, `createdAt` → `created_at` |
| invitation | `core_invitation` | `organizationId`, `inviterId`, `expiresAt`, `createdAt` → snake_case |

Extra columns the factory reads: `core_user.github_login` (fill it from the GitHub account on
sign-in: `.factory/policy.json` names approvers by login) and `core_organization.kind` /
`github_installation_id`. Member roles `owner` and `admin` are org admins.
