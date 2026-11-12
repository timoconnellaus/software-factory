// Release versions (spec 40 M4): canary is 0.1.<run number>, stable is the version the owner gives
// (1.2.3). Compared numerically, part by part; anything that isn't dotted numbers is no version.

/** The numeric parts of `1.2.3`, or null for anything else. */
export function parseVersion(v: string): number[] | null {
  if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(v)) return null;
  return v.split(".").map(Number);
}

/** -1, 0 or 1; null when either isn't a version. Missing parts count as 0 (1.2 = 1.2.0). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True only when `candidate` is a version strictly higher than `current`. */
export const isNewer = (candidate: string, current: string) =>
  compareVersions(candidate, current) === 1;
