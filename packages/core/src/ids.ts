// Ids are `<prefix>_<32 hex>`: random and URL-safe.

export const ID_PREFIXES = {
  audit: "au",
  outbox: "ob",
  githubInstallation: "ghi",
  deviceCode: "dev",
  cliDeviceCode: "cdc",
  cliToken: "cli",
  desktopAuthRequest: "dar",
  desktopDevice: "dsk",
  presenceChallenge: "prc",
  pairOffer: "pof",
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
