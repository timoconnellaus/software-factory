# Spec wi-4: A readable event log, shared by the web and the CLI

**Read first**: [spec 13](13-r1-work-item-detail.md) (the timeline tab), [spec 07](07-cli.md) (`sf timeline`),
[ADR 0011](../adr/0011-audit-journal-is-the-metrics.md) (the audit journal is the source), [ADR 0003](../adr/0003-operations-registry.md).

## Goal
A work item's event log reads the same everywhere. The web timeline already turns audit rows into
sentences (`apps/app/src/components/timeline.tsx`: a label table, `detailOf`, `actorLabel`, `dotFor`,
and the held / merged / note rules). `sf timeline` prints raw operation names (`pr.merge`,
`human:usr_…`, `ok`) instead. Move the wording into one pure module that both use, so the CLI reads
like the web and a new operation's wording is added once.

## Scope
- **One pure module** with no I/O, no React and no Node or Cloudflare imports, holding everything
  that turns an audit entry into words:
  - the operation → label table;
  - detail extraction (`workItem.triage`, `workItem.enterStage`, `workItem.create`, `pr.open`,
    `question.ask`, `spec.commit`, as today);
  - actor labelling (`you` / `a person` / the agent id / `runner <id>`);
  - the dot kind (done / running / waiting / failed / idle) as a plain string union the app maps to
    its `StatusDot`;
  - the held label (`Gate opened: <label> needs a person`), `pr.merge` + ok → `Merged`, and the note
    rule (the entry's reason is shown only when the call was held, refused or failed).
  One entry point, e.g. `describeEntry(entry, { me?, gate? })`, returns `{ label, detail, note, actor, dot }`.
- **Where it lives:** a new tiny workspace package (`packages/timeline`, zero runtime dependencies,
  plain erasable TypeScript with `.ts` import specifiers so Node 24 runs it as-is). `apps/app` and
  `local/cli` both depend on it with `workspace:*`. Neither keeps its own copy.
- **Web:** `timeline.tsx` calls the module and keeps only layout, `StatusDot`, `clock`, `duration`
  and gate matching (`gateFor`, gate time). Output is unchanged for every existing operation.
- **CLI:** `sf timeline` prints one readable line per entry through the module: time, label, actor,
  detail, and the outcome when it isn't `ok` (a held entry says so in its label), plus the reason for
  held, refused and failed entries. The CLI's `TimelineEntry` type gains the fields the endpoint
  already returns (`id`, `pendingActionId`, `result: unknown`). `--json` keeps printing the raw
  `{ entries }` exactly as now.
- **Docs:** spec 13 (the timeline's wording lives in the shared module; the CLI shows it), spec 07
  (what `sf timeline` prints, replacing the raw columns), `docs/specs/README.md` (a `wi-4` row,
  depends on 07 and 13), and `CONTEXT.md` / `docs/architecture.md` only if they describe the timeline.

## Out of scope
- Any change to what is journalled, to the `workItem.timeline` operation or its schema, or to the engine.
- New labels or reworded text for existing operations. This is a move plus the CLI, not a copy edit.
- Fetching gates in the CLI (so human decision notes and gate time stay web-only), and a CLI `you`
  (the CLI doesn't know the viewer's id, so humans print as `a person`).
- Grouping, filtering, paging or live-following the log, in either surface.
- Colour in CLI output, and any change to `--json`.

## Acceptance criteria
1. The label table, detail extraction and actor labelling live in one pure module used by both `apps/app` and `local/cli`; neither keeps its own copy.
2. The web timeline shows the same labels, details, notes and dots as before for every existing operation, and its existing tests still pass unchanged.
3. `sf timeline` prints readable lines (time, label, actor, detail, non-ok outcome) in the same wording as the web timeline, with no raw operation names in the default output; `--json` output is unchanged.
4. Entry formatting is tested for each known operation kind, including a held entry, a refused or failed entry with its reason, and a merged PR.
5. An unknown operation kind, and a known kind whose result is null, a non-object or has wrongly typed fields, falls back gracefully: raw name as the label, no detail, no exception.
6. A CLI test covers the `sf timeline` text output and that `--json` is unchanged.
7. `docs/specs/13`, `docs/specs/07` and `docs/specs/README.md` are updated and true.
8. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
9. A test pins the current web output for every key in the label table (label, detail, dot, note) and passes both before and after the extraction, so "unchanged" is checked against the old behaviour.
