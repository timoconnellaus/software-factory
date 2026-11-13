// Verifying a signed bundle before it may run (spec 45 §2, *Who verifies a copy*), shared by the
// desktop app's updater (apps/desktop/src/bun/update-verify.ts, spec 40 M4) and whatever moves a
// version of SF Runner.app into the runner root: the app installing its bundled copy, the service
// installing a download (§5). Pure over an injected `Exec`, so Node and Bun both run it.
//
// - `codesign --verify --deep --strict` against a requirement with the Team ID of the verifier's
//   own signature, never one from a manifest or a bucket; then the nested Node against the same
//   requirement with its own identifier (a valid nested signature from another team, or another
//   identifier, would pass the outer check);
// - `spctl --assess`: Gatekeeper's verdict, which needs Apple's notarization;
// - the bundle's own sealed `Contents/Resources/version.json`, which must say what was expected.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs a command; `code` is its exit status, `out` its stdout and stderr together. `timeoutMs` is
 * the app updater's bound on one command (apps/desktop/src/bun/update-verify.ts, withTimeout).
 */
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; out: string }>;

export const RUNNER_IDENTIFIER = "com.software-factory.runner";
/** Contents/Helpers/node's identifier (spec 45 §1, step 2). */
export const NODE_IDENTIFIER = "com.software-factory.runner.node";

const TEAM_ID = /^[A-Z0-9]{10}$/;

/** The Team ID the bundle at `app` is signed with, or null (unsigned, ad hoc, unreadable). */
export async function teamIdOf(app: string, exec: Exec): Promise<string | null> {
  const r = await exec("/usr/bin/codesign", ["-dv", "--verbose=2", app]);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(r.out)?.[1];
  return r.code === 0 && team ? team : null;
}

/**
 * The standard Developer ID requirement for `identifier` signed by `team` (spec 45 §1): Apple's
 * anchor, the Developer ID intermediate's and the Developer ID Application leaf's markers, the
 * Team ID. SF Runner's launcher checks the same string (Sources/LauncherCore/Seal.swift).
 */
export const developerIdRequirement = (identifier: string, team: string) =>
  `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`;

/** Null when the seal of `bundle` verifies (deep, strict) and meets `requirement`; else why not. */
export async function checkSignature(
  bundle: string,
  requirement: string,
  exec: Exec,
): Promise<string | null> {
  const sig = await exec("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=${requirement}`,
    bundle,
  ]);
  return sig.code === 0 ? null : `its signature doesn't check out: ${lastLine(sig.out)}`;
}

/** Null when Gatekeeper accepts `bundle` (notarized); else why not. */
export async function assess(bundle: string, exec: Exec): Promise<string | null> {
  const gk = await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", bundle]);
  return gk.code === 0 ? null : `Gatekeeper rejects it: ${lastLine(gk.out)}`;
}

/** A bundle's own `Contents/Resources/version.json`, or null. */
export function sealedVersion(
  app: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(read(join(app, "Contents", "Resources", "version.json")));
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** What a runner version must say about itself to be moved in (spec 45 §5, *Verified before use*). */
export interface ExpectedRunner {
  version: string;
  channel: string;
  runnerSha?: string;
  runnerSeq?: number;
}

/**
 * Null when `staged` is SF Runner.app signed by `team`, accepted by Gatekeeper and sealed with the
 * expected version.json; else why not. `team` is the verifier's own (teamIdOf on itself).
 */
export async function verifyRunnerBundle(
  staged: string,
  team: string | null,
  expected: ExpectedRunner,
  exec: Exec,
  read?: (p: string) => string,
): Promise<string | null> {
  if (!team || !TEAM_ID.test(team)) return "this build has no Team ID to check the runner against";
  const sig = await checkSignature(staged, developerIdRequirement(RUNNER_IDENTIFIER, team), exec);
  if (sig) return sig;
  const node = await checkSignature(
    join(staged, "Contents", "Helpers", "node"),
    developerIdRequirement(NODE_IDENTIFIER, team),
    exec,
  );
  if (node) return `Contents/Helpers/node: ${node}`;
  const gk = await assess(staged, exec);
  if (gk) return gk;
  const v = sealedVersion(staged, read);
  if (!v) return "it has no sealed version.json";
  for (const key of ["version", "channel", "runnerSha", "runnerSeq"] as const) {
    if (expected[key] !== undefined && v[key] !== expected[key])
      return `its sealed ${key} is ${JSON.stringify(v[key])}, not ${JSON.stringify(expected[key])}`;
  }
  return null;
}

const lastLine = (s: string) => s.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
