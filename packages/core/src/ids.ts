// Ids are `<prefix>_<32 hex>`: random, URL-safe, and valid as Workflow instance ids and event types.

export const ID_PREFIXES = {
  workItem: "wi",
  project: "prj",
  repository: "repo",
  factory: "fac",
  pendingAction: "pa",
  question: "q",
  spec: "spec",
  stage: "stg",
  job: "job",
  run: "run",
  reviewPacket: "rp",
  incident: "inc",
  audit: "au",
  outbox: "ob",
  githubInstallation: "ghi",
  deviceCode: "dev",
  attachment: "att",
  mergeQueueEntry: "mq",
  planningSession: "ps",
  planningMessage: "pm",
  specEdit: "pe",
  planningArtifact: "art",
  cliDeviceCode: "cdc",
  cliToken: "cli",
  desktopAuthRequest: "dar",
  desktopDevice: "dsk",
  presenceChallenge: "prc",
  pairOffer: "pof",
  trial: "trl",
  adjudication: "adj",
  runSteer: "st",
  terminalAttach: "ta",
  flake: "flk",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** A runner id (`r_` + 24 hex), the shape the signed channel accepts. */
export function newRunnerId(): string {
  return `r_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{32}$`);
}

/** A branch-safe slug: lowercase ASCII words joined by `-`, at most 40 characters. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "work";
}
