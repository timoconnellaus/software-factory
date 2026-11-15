# @software-factory/core

The platform the new core stands on. The old software pipeline (work items, specs, planning, the
merge queue, verify, policies and the rest) was deleted at cutover (spec 70, milestone 5); the
workflow engine is now `packages/flow`, `packages/store`, `packages/ops` and `packages/plugins`.
The package keeps its name.

What is left here:

| Module | What |
| --- | --- |
| `invoke.ts` | The pipeline every platform call goes through: idempotency → validate → scope (the input's `orgId`) → actor check → browser-only and presence proofs → permission → handler → one D1 batch (writes, guards, the audit row, outbox rows) → deliver. |
| `registry.ts`, `operation.ts` | `defineOperation`, the registry, `describeOperations()`. |
| `operations/cli.ts` | The `sf` CLI's device login and its tokens. |
| `operations/desktop.ts`, `device.ts` | The desktop app's sign-in, its device key, devices, and presence proofs (ADR 0391). |
| `operations/mobile.ts`, `attestation/` | The phone's sign-in with Android key attestation, pairing and renewal (ADR 0541). |
| `operations/devices.ts`, `runners.ts` | A runner's device login, registration, keys, the owner's list and account pick, and what a runner reports on its heartbeat and claim (versions, compat). |
| `operations/github.ts` | Connecting the org's GitHub App installation, and its installation webhook. |
| `operations/orgs.ts` | `org.list`. |
| `testing/` | A D1-backed fake GitHub App (`GITHUB_FAKE=1`) and test services. |

```ts
import { invoke } from "@software-factory/core";
const result = await invoke(deps, "org.list", {}, {
  actor: { type: "human", id: userId },
  origin: { surface: "cli" },
});
// { status: "ok", output, auditId }; refusals throw OperationError { code, message, details }
```

`deps` is `{ d1, services, deliver? }`. Operations run in `sf-engine`: the client door
(`/client/v1`, `/cli/v1`), the runner channel (`/runner/v1`), the GitHub webhook, and the
`EngineApi` RPC that the website calls. Every write is journaled in `core_audit`.
