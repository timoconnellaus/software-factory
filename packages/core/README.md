# @software-factory/core

The operations registry and every V1 operation, the `invoke()` pipeline, the gate (autonomy policy
+ project overrides + floor), the `.factory/policy.json` schema, model roles and the Workflow's event
names (ADRs 0003, 0004, 0008, 0018, 0054, 0110).

```ts
import { invoke, describeOperations, FOREMAN } from "@software-factory/core";
const result = await invoke(deps, "workItem.create", { projectId, title }, {
  actor: { type: "human", id: userId },
  origin: { surface: "app" },
});
// { status: "ok", output, auditId } | { status: "pending", pendingActionId, auditId }
// refusals throw OperationError { code: denied | forbidden | killed | fenced | conflict | not_found | invalid_input | unavailable | bad_approval }
```

`deps` is `{ d1, services, floor?, deliver? }`. In V1 operations run in `sf-engine`
(ADR 0051); `sf-app` calls them through the engine's `EngineApi` RPC. Tests use
`@software-factory/core/testing` (`fakeServices(d1)`: a D1-backed fake GitHub App).

The pipeline: idempotency → validate → scope + policy at the default-branch SHA → actor check → kill
switch → gate check → fencing token → permission → handler → one D1 batch (writes + guards + audit
row + outbox rows) → deliver. `describeOperations()` lists every operation with its description,
risk class, actors, permission and gate kind; `docs/handoff.md` has the catalogue by caller.
