# ADR 0050: Kysely for typed D1 access, and batch guards for atomic conditional writes

Status: accepted, 2026-11-11 (V1 core + engine).

## Context
Spec 01 asks for typed access to D1 (Kysely or Drizzle) and every operation's writes, audit row
and outbox rows in one D1 batch ([ADR 0004](0004-invoke-pipeline-and-gate.md)). D1 has no interactive
transactions, so a handler reads, then queues writes; between the read and the batch another call
can change the state (two runners claiming one job, two tabs deciding one gate, a takeover racing a
hand-back).

## Decision
- **Kysely**, as in the CRM (its ADR 0014): `packages/db` has the `core_*` table types
  (`schema.ts`, hand-maintained next to the SQL), a small D1 dialect for reads, and `toStatement()`
  to compile a Kysely query into a `D1PreparedStatement` for `batch()`. Migrations stay plain SQL in
  `packages/db/migrations`, applied by `wrangler d1 migrations apply` (deploy) and
  `applyD1Migrations` (tests).
- **Batch guards.** `core_batch_guard (name, ok CHECK (ok > 0))`. A guarded write is followed in the
  same batch by `INSERT INTO core_batch_guard SELECT name, changes()` (the previous statement must
  have changed a row) or `… EXISTS (<select>)` (a condition must still hold). A failed guard violates
  the CHECK and aborts the whole batch; every batch ends with `DELETE FROM core_batch_guard`.
  Handlers use `ctx.guardChanged()` / `ctx.guardExists()`; `invoke()` maps a failed guard to the
  refusal `conflict` and audits it. The fencing check is a guard too, so a token bumped between the
  read and the batch still refuses the write.
- Tables: `core_*`, snake_case; Better Auth's tables are `core_user`, `core_session`, `core_account`,
  `core_verification`, `core_organization`, `core_member`, `core_invitation` with snake_case columns
  (the app maps Better Auth's camelCase fields onto them).
- `SCHEMA_VERSION` in `packages/db` equals the highest migration; `core_meta.schema_version` only goes
  up (migrations use `MAX`), so blocks applied out of order don't lower it.

## Consequences
- Conditional writes are atomic without Durable Objects. `changes()` inside a D1 batch is covered by
  a test (`packages/db/test/schema.test.ts`).
- Table types can drift from the SQL; a schema-introspection test can come later.
