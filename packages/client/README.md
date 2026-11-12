# @software-factory/client

What both front ends need that isn't React: sf-app (`apps/app`) and the desktop app (`apps/desktop`,
spec 40 M3) import it, so a screen's logic is written and tested once.

| Module | What |
| --- | --- |
| `ops` | `OpMap` (each operation's input and output, typed from `packages/core`'s zod schemas, types only), `OpError`, and the view types (`WorkItemDetail`, `Inbox`, …). |
| `format` | `ago`, `duration`, `clock`, stage labels, `itemKey`, `errorMessage`. |
| `inbox` | Cards grouped by project with each project's WIP hold (spec 12). |
| `packet` | Reading a stored review packet and its sections (spec 14, spec 04). |
| `planning` | The Planning tab's pill, provenance chips, changed blocks and gate bar (spec 20). |
| `questions` | Which answers to offer, and which questions can be bulk-accepted (ADR 0042). |
| `work-item` | The pipeline steps, your time and agent time, the status dot (spec 13). |
| `runners` | The runner health line's words (spec 12, ADR 0360). |
| `attachments` | Pasted and dropped files, and the quick check before an upload (ADR 0310). |
| `runner-pairing` | The commands Setup copies for a runner. |

How an operation travels is each app's business: sf-app's server functions, or the desktop's main
process and the client door. Nothing here does I/O. Tests run in workerd (`pnpm test`).
