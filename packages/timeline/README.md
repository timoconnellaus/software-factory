# @software-factory/timeline

A work item's event log in words (spec [wi-4](../../docs/specs/wi-4-let-s-improve-the-event-log-so-it-s-usef.md)).
`describeEntry(entry, { me?, gate? })` turns one `workItem.timeline` entry (a row of the audit
journal, ADR 0011) into `{ label, detail, note, actor, dot, outcome }`. The dashboard's timeline
(spec 13) and `sf timeline` (spec 07) both call it, so an operation's wording is added once, here.

- **label**: the operation's name in words (`LABELS`), or the raw operation name for one not in the
  table. A held call reads `Gate opened: <label> needs a person`; a merged PR reads `Merged`.
- **detail**: what the result adds, for `workItem.triage`, `workItem.enterStage`, `workItem.create`,
  `pr.open`, `question.ask` and `spec.commit`. A result of the wrong shape gives none.
- **note**: the decision's note when the caller passes the gate a person decided; otherwise the
  entry's reason, only when the call was held, refused or failed.
- **actor**: `you` (when `me` matches), `a person`, the agent's id, or `runner <id>`.
- **dot**: `done`, `running`, `waiting`, `failed` or `idle`; the dashboard maps it to its `StatusDot`.
- **outcome**: the outcome when it is neither `ok` nor `review` (a held call says so in its label).

Plain erasable TypeScript with no imports and no I/O, so workerd, the browser and Node 24 all run it
as-is.
