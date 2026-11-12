// A stage type's gate judged as the operation it opens would be (spec 52): the gate spec's risk and
// `alwaysReview` through the same `operationGate()` that `invoke()` runs, so the registry can't say
// less than the operation does. The comparison test and the reconciler read it.
import type { ActorType } from "../actors.ts";
import {
  type FloorParse,
  type GatePolicy,
  type GateResult,
  operationGate,
} from "../policy/gate.ts";
import type { GateSpec } from "./contract.ts";

export function stageGateDecision(
  gate: GateSpec,
  at: {
    actor: ActorType;
    policy: GatePolicy | null;
    floor: FloorParse;
    pinnedPolicy?: GatePolicy | null;
  },
): GateResult {
  return operationGate({
    op: { name: gate.operation, alwaysReview: gate.alwaysReview },
    risk: gate.risk,
    ...at,
  });
}
