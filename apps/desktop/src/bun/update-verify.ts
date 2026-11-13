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
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const APP_IDENTIFIER = "com.software-factory.desktop";

/**
 * Runs a command; `code` is its exit status, `out` its stdout and stderr together. `timeoutMs`, when
 * given, is how long the command may run before it is killed (bunExec's own default otherwise).
 */
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number; out: string }>;

/**
 * How long one command may run. spctl's first assessment of a bundle asks Apple's notary service and
 * took 7.5–13 s on the owner's Mac; a helper or check that hangs past this is killed and reported as
 * failed, so it can't stop update checks (or a restart to update) for the rest of the session.
 */
export const EXEC_TIMEOUT_MS = 120_000;
/** The exit code reported for a command that ran out of time (as coreutils' timeout(1) does). */
export const TIMED_OUT = 124;

/**
 * `exec` bounded to `ms` (or a caller's shorter `timeoutMs`): a command still running then is
 * reported as failed (`TIMED_OUT`). The deadline is passed down, so the spawner kills the process at
 * it (bunExec asks Bun to SIGKILL it); this bound holds even when a child keeps the output pipes open
 * after that.
 */
export function withTimeout(exec: Exec, ms: number = EXEC_TIMEOUT_MS): Exec {
  return async (cmd, args, opts) => {
    const limit = Math.min(ms, opts?.timeoutMs ?? ms);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exec(cmd, args, { timeoutMs: limit }),
        new Promise<{ code: number; out: string }>((resolve) => {
          timer = setTimeout(
            () => resolve({ code: TIMED_OUT, out: `${cmd} timed out after ${limit / 1000} s` }),
            limit,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

const spawnExec: Exec = async (cmd, args, opts) => {
  const p = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: `${out}${err}` };
};

/** Runs a command under Bun, killed after EXEC_TIMEOUT_MS. */
export const bunExec: Exec = withTimeout(spawnExec);

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

/**
 * Removes a staged update so Electrobun downloads it again: its prepared-update record, then the
 * staging folder, only when it is Electrobun's own `<running app>.prepared-<hash>` beside the running
 * bundle (anything else is left alone). Without the record, Electrobun's next check reports nothing
 * prepared.
 */
export function discardStaged(
  appDataFolder: string,
  stagingPath: string,
  appPath: string,
  rm: (p: string, opts: { recursive: boolean; force: boolean }) => void = rmSync,
): void {
  rm(join(appDataFolder, "self-extraction", ".electrobun-prepared-update.json"), {
    recursive: false,
    force: true,
  });
  if (isOwnStaging(stagingPath, appPath)) rm(stagingPath, { recursive: true, force: true });
}

/** `staging` is `<app>.prepared-<hash>` in the running app's own folder (no `..`, no other name). */
export function isOwnStaging(staging: string, appPath: string): boolean {
  const app = resolve(appPath);
  if (!app.endsWith(".app") || resolve(staging) !== staging) return false;
  if (dirname(staging) !== dirname(app)) return false;
  const name = basename(staging);
  const prefix = `${basename(app)}.prepared-`;
  return name.startsWith(prefix) && /^[a-z0-9]{1,13}$/.test(name.slice(prefix.length));
}
