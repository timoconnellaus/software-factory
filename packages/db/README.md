# @software-factory/db

The `core_*` schema (plain SQL in [`migrations/`](migrations/), applied by `wrangler d1 migrations
apply` from `apps/engine` and by `applyD1Migrations` in tests) and typed access through Kysely
(ADR 0050). Nothing writes these tables except operations in `packages/core` (and Better Auth, its
own tables). The new core's `flow_*` tables are written by `packages/store`.

```ts
import { createDb, toStatement, guardChanged, SCHEMA_VERSION } from "@software-factory/db";
const db = createDb(env.DB);            // typed reads
d1.batch([toStatement(env.DB, db.updateTable(...)), guardChanged(env.DB, "name"), ...]);
```

## Tables
After the cutover (migration 0438, spec 70 milestone 5) the `core_*` tables are the platform's:

| Tables | What |
| --- | --- |
| `core_meta` | `schema_version` |
| `core_user`, `core_session`, `core_account`, `core_verification`, `core_organization`, `core_member`, `core_invitation` | Better Auth: sign-in and orgs |
| `core_cli_device_codes`, `core_cli_tokens`, `core_desktop_auth_requests`, `core_desktop_devices`, `core_presence_challenges`, `core_mobile_nonces`, `core_pair_offers`, `core_pair_code_tries` | The doors' sign-ins, devices, tokens and presence proofs |
| `core_runners`, `core_runner_shares`, `core_runner_device_codes`, `core_channel_requests` | Runners and the channel's idempotency store |
| `core_github_installations`, `core_github_connect_states` | The org's GitHub App installations |
| `core_audit` (append-only), `core_outbox`, `core_batch_guard` | The journal, delivery after commit, batch guards |
| `flow_*` | The new core (ADR 0660, spec 70), written by `packages/store`, not by `packages/core` |

Migration 0438 dropped every table only the old pipeline used (work items, specs, planning, the
merge queue, verify, runs and jobs, policies, incidents, the audit archive and the rest).
`SCHEMA_VERSION` equals the highest migration. Parallel builds number their migrations from the
block they claim in `docs/parallel-work.md`.

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

Extra columns the factory reads: `core_user.github_login` (filled from the GitHub account on
sign-in: connecting an installation on the person's own account checks it) and `core_organization.kind` /
`github_installation_id`. Member roles `owner` and `admin` are org admins.
