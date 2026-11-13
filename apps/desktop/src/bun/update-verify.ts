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
//
// The signature, Gatekeeper and Team ID checks are shared with SF Runner.app's verifier
// (@software-factory/runner-host/bundle-verify, spec 45 §2).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assess,
  checkSignature,
  type Exec,
  teamIdOf,
} from "@software-factory/runner-host/bundle-verify";

export type { Exec };
export { teamIdOf };

export const APP_IDENTIFIER = "com.software-factory.desktop";

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

export const requirement = (team: string) =>
  `anchor apple generic and identifier "${APP_IDENTIFIER}" and certificate leaf[subject.OU] = "${team}"`;

/** Null when `staged` is this app, signed by `team` and accepted by Gatekeeper; else why not. */
export async function verifyBundle(
  staged: string,
  team: string,
  exec: Exec,
): Promise<string | null> {
  if (!/^[A-Z0-9]{10}$/.test(team)) return "this build has no Team ID to check updates against";
  return (await checkSignature(staged, requirement(team), exec)) ?? (await assess(staged, exec));
}

/**
 * The .app Electrobun staged. Its record's `staging_path` is a folder that holds the new bundle
 * under the running app's own name (`<App>.app.prepared-<hash>/<App>.app`), not the bundle itself:
 * checking the folder made every update fail with "Is a directory" (found on the first real
 * self-update, 0.1.44 to 0.1.48). The name comes from the running app, never from the record, so
 * the bundle checked is the one that would replace it.
 */
export const stagedBundle = (stagingPath: string, appPath: string) =>
  stagingPath.endsWith(".app") ? stagingPath : join(stagingPath, basename(appPath));

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

/**
 * A hash of everything in a bundle: every path, its kind, mode and size, a symlink's target and a
 * file's bytes, in a fixed order. Taken when the staged bundle passes the checks above and taken
 * again before applying: equal means the bundle applied is, byte for byte, the one checked. About
 * 0.2 s for the app's 212 MB (the signature checks take seconds: spctl asks Apple's notary).
 */
export async function bundleFingerprint(app: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string, rel: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const at = rel ? `${rel}/${name}` : name;
      const st = await lstat(path);
      if (st.isSymbolicLink()) hash.update(`L\0${at}\0${await readlink(path)}\n`);
      else if (st.isDirectory()) {
        hash.update(`D\0${at}\0${st.mode}\n`);
        await walk(path, at);
      } else if (st.isFile()) {
        hash.update(`F\0${at}\0${st.mode}\0${st.size}\n`);
        hash.update(await readFile(path));
      } else hash.update(`O\0${at}\n`);
    }
  }
  await walk(app, "");
  return hash.digest("hex");
}

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
