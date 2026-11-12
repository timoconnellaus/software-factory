// The registered stage types. Built-in code only: there are no loadable types (ADR 0510).
import type { AnyStageType } from "./contract.ts";
import { agentCheck } from "./types/agent-check.ts";
import { build } from "./types/build.ts";
import { checks } from "./types/checks.ts";
import { decision } from "./types/decision.ts";
import { interviewPlanning } from "./types/interview-planning.ts";
import { publish } from "./types/publish.ts";
import { triage } from "./types/triage.ts";

export const STAGE_TYPES: readonly AnyStageType[] = [
  triage,
  interviewPlanning,
  agentCheck,
  decision,
  build,
  checks,
  publish,
];

const BY_ID = new Map(STAGE_TYPES.map((t) => [t.id, t]));

export function stageType(id: string): AnyStageType | undefined {
  return BY_ID.get(id);
}

/**
 * The type versions the registry still runs, per type. A version stays until no open stage entry
 * started on it (ADR 0511); today every type is at 1.
 */
export function supportedVersions(id: string): readonly number[] {
  const t = BY_ID.get(id);
  return t ? [t.version] : [];
}

/** Connector kinds the factory has. A stage needing another can't be saved (F9). */
export const KNOWN_CONNECTORS: readonly string[] = ["github"];
