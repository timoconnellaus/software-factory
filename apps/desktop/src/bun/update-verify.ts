// Checks a staged update before it may replace the app (spec 40 M4).
//
// Electrobun's updater trusts the download bucket: it installs any manifest whose build hash
// differs, and the only integrity check is a sha256 from that same manifest. Its helper never
// checks a code signature, and the new bundle isn't quarantined, so Gatekeeper never looks at it.
// So before applying, the app checks the staged bundle itself:
// - `codesign --verify --deep --strict` against a requirement pinned to this app's identifier and
//   the Team ID this running app is signed with. The Team ID comes from the running build's own
//   signature, never from the manifest or the bucket. An unsigned running build takes no updates.
// - `spctl --assess`: Gatekeeper's verdict, which needs Apple's notarization.
// Either failing refuses the update.
// - Then the version and channel are read from the staged bundle's own
//   `Contents/Resources/version.json`, which sits inside the seal just verified. The manifest's
//   version (which Electrobun copies into its record) is the bucket's word; a genuine, older signed
//   build served under a manifest saying 9.9.9 passes both checks above, so the bundle's own
//   version must equal the manifest's and be newer than the running one (updates.ts).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const APP_IDENTIFIER = "com.software-factory.desktop";

/** Runs a command; `code` is its exit status, `out` its stdout and stderr together. */
export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

export const bunExec: Exec = async (cmd, args) => {
  const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: `${out}${err}` };
};

/** The running .app (Contents/MacOS/<exe> → the bundle), as Electrobun's updater computes it. */
export const runningAppPath = () => resolve(dirname(process.execPath), "..", "..");

/** The Team ID the bundle at `app` is signed with, or null (unsigned, ad hoc, unreadable). */
export async function teamIdOf(app: string, exec: Exec): Promise<string | null> {
  const r = await exec("/usr/bin/codesign", ["-dv", "--verbose=2", app]);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(r.out)?.[1];
  return r.code === 0 && team ? team : null;
}

export const requirement = (team: string) =>
  `anchor apple generic and identifier "${APP_IDENTIFIER}" and certificate leaf[subject.OU] = "${team}"`;

/** Null when `staged` is this app, signed by `team` and accepted by Gatekeeper; else why not. */
export async function verifyBundle(
  staged: string,
  team: string,
  exec: Exec,
): Promise<string | null> {
  if (!/^[A-Z0-9]{10}$/.test(team)) return "this build has no Team ID to check updates against";
  const sig = await exec("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=${requirement(team)}`,
    staged,
  ]);
  if (sig.code !== 0) return `its signature doesn't check out: ${lastLine(sig.out)}`;
  const gk = await exec("/usr/sbin/spctl", ["--assess", "--type", "execute", staged]);
  if (gk.code !== 0) return `Gatekeeper rejects it: ${lastLine(gk.out)}`;
  return null;
}

/** The version and channel a bundle says it is, from its own Resources/version.json, or null. */
export function bundleInfo(
  app: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { version: string; channel: string } | null {
  try {
    const doc = JSON.parse(read(join(app, "Contents", "Resources", "version.json"))) as Record<
      string,
      unknown
    >;
    const { version, channel } = doc;
    return typeof version === "string" && typeof channel === "string" ? { version, channel } : null;
  } catch {
    return null;
  }
}

const lastLine = (s: string) => s.trim().split("\n").at(-1)?.slice(0, 200) ?? "";

export interface StagedUpdate {
  version: string;
  hash: string;
  path: string;
}

/**
 * The update Electrobun has staged, from its prepared-update record in the channel's app-data
 * folder. Only the staged-bundle form (schema 2, what Electrobun 2.0.6 writes) can be checked
 * before it is applied; anything else is null, and so refused.
 */
export function stagedUpdate(
  appDataFolder: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): StagedUpdate | null {
  try {
    const doc = JSON.parse(
      read(join(appDataFolder, "self-extraction", ".electrobun-prepared-update.json")),
    ) as Record<string, unknown>;
    const { schema_version, staging_path, version, hash } = doc;
    if (schema_version !== 2) return null;
    if (typeof staging_path !== "string" || typeof version !== "string" || typeof hash !== "string")
      return null;
    return { version, hash, path: staging_path };
  } catch {
    return null;
  }
}
