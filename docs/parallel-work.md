# Parallel work

Several sessions often build at once on one shared Mac. The rules are in
[`AGENTS.md`](../AGENTS.md); this page repeats the ones code comments point at.

- **Migrations** are numbered one at a time: the next number above the highest in
  `packages/db/migrations`. `SCHEMA_VERSION` in `packages/db/src/index.ts` equals it. If `main`
  took your number before you merge, renumber yours. There are no claimed blocks any more.
- **ADRs** take the next number after the highest in `docs/adr/`.
- **One shared Mac.** Run the tests you touched, with `pnpm test --concurrency=2` for the whole
  suite (CI caps it the same way). Use your own port for a dev server. Never stop or kill a process
  you didn't start.
- **Files that conflict often**: the op maps and contract lists (`packages/client/src/flow*.ts`,
  `packages/client/src/flow-contract.ts`), `SCHEMA_VERSION`, the screenshot fixtures in
  `apps/desktop/screenshots/`, and `pnpm-lock.yaml`. Keep both sides, then run `pnpm i`.
- Merge `origin/main` into your branch with a merge commit; never rebase.
