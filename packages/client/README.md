# @software-factory/client

What the front ends need that isn't React: the desktop app (`apps/desktop`) and the website
(`apps/app`) import it, so a screen's logic is written and tested once.

| Module | What |
| --- | --- |
| `ops` | `OpMap` (each platform operation's input and output, typed from `packages/core`'s zod schemas, types only, plus the new core's `flow.*`), `OpError` and `Json`. |
| `flow`, `flow-edit`, `flow-run`, `flow-chat`, `flow-chat-steps`, `flow-auto` | The new core's views: the board, the item and its timeline, the workflow editor, plugins and gateways, the run view, Chat and Auto (spec 70). |
| `flow-contract` | The flow operations' output schemas, checked against the engine's answers. |
| `format` | `ago`. |

How an operation travels is each app's business: the website's server functions, or the desktop's
main process and the client door. Nothing here does I/O. Tests run in workerd (`pnpm test`).
