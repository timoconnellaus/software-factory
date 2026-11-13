// Editing an org agent against a version (review of #159, round 3). The version the edit started
// from is captured once, when the form opens, and changes only on "Keep my changes" (or closing):
// typing never re-bases it, so a save by someone else in between is seen, not silently replaced.
// Keep merges: fields this edit touched keep its values, the rest take the newer version's.

export type Agent = { name: string; role: string; tier?: string; instructions?: string } & Record<
  string,
  unknown
>;

export interface AgentEdit {
  /** What the form shows. */
  draft: Agent;
  /** The agent as it was when the edit started (or was kept), to see what this edit touched. */
  original: Agent;
  /** The org config version the edit is based on: the save names it. */
  base: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const openAgent = (agent: Agent, version: number): AgentEdit => ({
  draft: { ...agent },
  original: { ...agent },
  base: version,
});

/** A keystroke: the draft changes, the base never does. */
export const typeIn = (edit: AgentEdit, patch: Partial<Agent>): AgentEdit => ({
  ...edit,
  draft: { ...edit.draft, ...patch },
});

/** The saved agent this edit is about: by its original name, or (a new one) the name typed. */
export function latestOf(agents: Agent[], edit: AgentEdit): Agent | null {
  const name = (edit.original.name || edit.draft.name).trim().toLowerCase();
  return name ? (agents.find((a) => a.name.toLowerCase() === name) ?? null) : null;
}

/** Fields both this edit and the newer version changed, differently: "Keep" replaces those. */
export function conflicts(edit: AgentEdit, latest: Agent | null): string[] {
  if (!latest) return [];
  const keys = new Set([...Object.keys(edit.draft), ...Object.keys(latest)]);
  return [...keys]
    .filter(
      (k) =>
        !same(edit.draft[k], edit.original[k]) &&
        !same(latest[k], edit.original[k]) &&
        !same(edit.draft[k], latest[k]),
    )
    .sort();
}

/** Keep my changes on `version`: touched fields stay mine, untouched ones take `latest`'s. */
export function keepOn(edit: AgentEdit, latest: Agent | null, version: number): AgentEdit {
  if (!latest) return { ...edit, base: version };
  const draft: Agent = { ...latest };
  for (const k of new Set([...Object.keys(edit.draft), ...Object.keys(edit.original)]))
    if (!same(edit.draft[k], edit.original[k])) draft[k] = edit.draft[k];
  return { draft, original: { ...latest }, base: version };
}
