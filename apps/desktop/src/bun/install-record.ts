// Keeping Electrobun's install record true, and saying when an update didn't install (spec 40 M4).
//
// Electrobun 2.0.6 keeps an install record per channel, `<channel root>/.electrobun-uninstall.json`
// (the channel root is ~/Library/Application Support/<identifier>/<channel>), with a copy of its
// update helper beside it (`uninstall`). Applying an update, the helper (extractor/main.zig,
// apply-update's validating phase) refuses with InvalidUpdateIdentity unless the record's
// `identifier` and `channel` are this app's and its `app_bundle_path` is exactly the running app's
// bundle. The record is written only when
// Electrobun's installer extracts the app, after an update it applied, or by the launcher's
// `--bootstrap-install`, and the launcher runs that only when the record (or the helper) is
// missing. `--refresh-metadata` keeps the recorded path. So an app first opened in one place and
// then moved (Downloads to Applications, or a local test build) keeps a record naming the old
// place, and every update fails after the restart, with the old version relaunched.
// The fix is the supported one: when the record is missing, unreadable or names another bundle,
// the running app's own bundled helper is run with `--bootstrap-install <channel root> --quiet`,
// which rewrites the record (and the helper copy) for the bundle it sits in.
//
// The helper writes each attempt's outcome to `<channel root>/.electrobun-update-<txn>.result.json`.
// After a relaunch the newest one says whether the last update installed.
// Nothing here imports Electrobun, so the tests run on Node.
import { lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isNewer } from "../shared/version.ts";
import { APP_IDENTIFIER, type Exec, TIMED_OUT, withTimeout } from "./update-verify.ts";

export const RECORD_FILE = ".electrobun-uninstall.json";
const RESULT_FILE = /^\.electrobun-update-([a-f0-9]{32})\.result\.json$/;

/** What the record decision needs to know. */
export interface RecordFacts {
  /** The record's text, or null when there is none. */
  record: string | null;
  /** Whether the helper copy beside it exists. */
  helper: boolean;
  /** The running .app, symlinks resolved. */
  appPath: string;
  /** The running build's channel (canary, stable). */
  channel: string;
  /** This app's bundle identifier; APP_IDENTIFIER unless a test says otherwise. */
  identifier?: string;
}

export type RecordVerdict =
  | { action: "ok" }
  | {
      action: "bootstrap";
      /** "identity": the record is for another identifier or channel (the helper checks both). */
      why: "missing" | "unreadable" | "moved" | "identity";
      recorded?: string;
    };

/**
 * Whether the install record must be rewritten for the running bundle: everything the helper's
 * validating phase compares (identifier, channel, app_bundle_path) must match, or the update fails
 * with InvalidUpdateIdentity after the restart and Retry fails the same way. Pure, for the tests.
 */
export function recordVerdict(f: RecordFacts): RecordVerdict {
  if (f.record === null || !f.helper) return { action: "bootstrap", why: "missing" };
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(f.record);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    doc = parsed as Record<string, unknown>;
  } catch {
    return { action: "bootstrap", why: "unreadable" };
  }
  const { app_bundle_path: recorded, identifier, channel } = doc;
  if (typeof recorded !== "string" || typeof identifier !== "string" || typeof channel !== "string")
    return { action: "bootstrap", why: "unreadable" };
  if (recorded !== f.appPath) return { action: "bootstrap", why: "moved", recorded };
  if (identifier !== (f.identifier ?? APP_IDENTIFIER) || channel !== f.channel)
    return { action: "bootstrap", why: "identity", recorded: `${identifier}/${channel}` };
  return { action: "ok" };
}

/** How long the helper may take to rewrite the record before it counts as failed. */
export const HELPER_TIMEOUT_MS = 60_000;

export interface RecordDeps {
  exec: Exec;
  read?: (p: string) => string | null;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  log?: (line: string) => void;
  /** The helper's time limit (HELPER_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Makes the install record name the running bundle (see above). Never throws: an update that still
 * can't install says so after the relaunch. Returns what it did, for the log and the tests.
 */
export async function syncInstallRecord(
  channelRoot: string,
  appPath: string,
  channel: string,
  deps: RecordDeps,
): Promise<RecordVerdict | { action: "failed"; error: string }> {
  const read =
    deps.read ??
    ((p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const exists = deps.exists ?? ((p) => lstatSync(p, { throwIfNoEntry: false })?.isFile() === true);
  const realpath = deps.realpath ?? ((p) => realpathSync(p));
  const log = deps.log ?? ((line) => console.log(line));
  try {
    const app = realpath(appPath);
    const verdict = recordVerdict({
      record: read(join(channelRoot, RECORD_FILE)),
      helper: exists(join(channelRoot, "uninstall")),
      appPath: app,
      channel,
    });
    if (verdict.action === "ok") return verdict;
    const helper = join(app, "Contents", "Resources", "uninstall");
    // Bounded: a hung helper would otherwise hold up every update check (and Restart to update).
    const exec = withTimeout(deps.exec, deps.timeoutMs ?? HELPER_TIMEOUT_MS);
    const r = await exec(helper, ["--bootstrap-install", channelRoot, "--quiet"]);
    if (r.code !== 0) {
      const error =
        r.code === TIMED_OUT
          ? `install record (${verdict.why}): the helper didn't finish: ${r.out}`
          : `install record (${verdict.why}): the helper exited ${r.code}: ${r.out.trim().slice(-300)}`;
      log(`updates: ${error}`);
      return { action: "failed", error };
    }
    log(
      `updates: install record rewritten for ${app} (${verdict.why}${verdict.action === "bootstrap" && verdict.recorded ? `, it named ${verdict.recorded}` : ""})`,
    );
    return verdict;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`updates: install record: ${message}`);
    return { action: "failed", error: message };
  }
}

/** The helper's phases (Electrobun 2.0.6, NativeUpdateResultV1), in our words. */
const PHASES: Record<string, string> = {
  validating: "checking the update before installing it",
  waiting_for_parent: "waiting for the app to quit",
  extracting: "unpacking the update",
  validating_payload: "checking the unpacked update",
  swapping: "replacing the app",
  integrating: "finishing the install",
  launching: "opening the new version",
  complete: "finishing",
};

/** Electrobun's failure codes we can explain, in our words. */
const CODES: Record<string, string> = {
  InvalidUpdateIdentity:
    "the updater's record of where the app is installed named another copy (the app was moved after it was first opened)",
  InvalidUpdatePath: "the app wasn't where the updater expected it",
};

/** A result field is shown only as one of our sentences; anything else is ignored. */
const CODE = /^[A-Za-z_]{1,64}$/;
const SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?$/;

/** One update attempt's outcome, as Electrobun's helper wrote it (validated: see parseUpdateResult). */
export interface UpdateResult {
  success: boolean;
  phase: string;
  message: string;
  version: string;
  modifiedAt: number;
}

/** A failed update to show after the relaunch. */
export interface InstallFailure {
  version: string;
  /** Electrobun's own code (InvalidUpdateIdentity, …), for the log. */
  message: string;
  phase: string;
}

/**
 * The helper's result file, or null when it isn't one this app trusts to show: the version must be
 * semver and the phase and message bare codes (letters and underscores, bounded). The file sits in
 * a folder any process of this user can write, so nothing in it reaches the UI as written.
 */
export function parseUpdateResult(text: string, modifiedAt: number): UpdateResult | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const { success, phase, message, version } = doc as Record<string, unknown>;
  if (typeof success !== "boolean") return null;
  if (typeof version !== "string" || !SEMVER.test(version)) return null;
  if (typeof phase !== "string" || !CODE.test(phase)) return null;
  if (typeof message !== "string" || !CODE.test(message)) return null;
  return { success, phase, message, version, modifiedAt };
}

/**
 * The update that didn't install, from the helper's results: the newest result, when it failed for
 * a version newer than the running one. A newer success, or the running build being that version
 * (or newer) already, means there is nothing to say. Pure, for the tests.
 */
export function lastFailure(results: UpdateResult[], running: string): InstallFailure | null {
  const newest = [...results].sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  if (!newest || newest.success) return null;
  if (!isNewer(newest.version, running)) return null;
  return { version: newest.version, message: newest.message, phase: newest.phase };
}

/** The most old result files deleted in one read (the rest go next time). */
const MAX_LISTED = 1024;

export interface ResultDeps {
  list?: (dir: string) => string[];
  stat?: (path: string) => { isFile(): boolean; size: number; mtimeMs: number };
  read?: (path: string) => string;
  remove?: (path: string) => void;
}

/**
 * The helper's newest result files in the channel root (a bounded, plain-file read): sorted newest
 * first before the limit, so the newest failure is never the one dropped. Results older than the
 * newest `keep` are deleted: each attempt leaves one, and none is read again.
 */
export function readUpdateResults(
  channelRoot: string,
  limit = 20,
  deps: ResultDeps = {},
): UpdateResult[] {
  const list = deps.list ?? ((d) => readdirSync(d));
  const stat = deps.stat ?? ((p) => lstatSync(p));
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const remove = deps.remove ?? ((p) => unlinkSync(p));
  let names: string[];
  try {
    // Every matching name is statted: the newest may be anywhere in the listing's order.
    names = list(channelRoot).filter((n) => RESULT_FILE.test(n));
  } catch {
    return [];
  }
  const files: { path: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    const path = join(channelRoot, name);
    try {
      const st = stat(path);
      if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Gone since the listing.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: UpdateResult[] = [];
  for (const f of files.slice(0, limit)) {
    if (f.size > 16_384) continue;
    try {
      const r = parseUpdateResult(read(f.path), f.mtimeMs);
      if (r) out.push(r);
    } catch {
      // Not a result this app can read: left alone.
    }
  }
  // Beyond the newest `limit`, at most MAX_LISTED a call: the rest go next time.
  for (const f of files.slice(limit, limit + MAX_LISTED)) {
    try {
      remove(f.path);
    } catch {
      // Left for next time.
    }
  }
  return out;
}

/** Electrobun's failure in our own sentences, for a person; its code goes to the log only. */
export function plainInstallFailure(f: InstallFailure): string {
  const version = SEMVER.test(f.version) ? f.version : "the new version";
  // Own keys only: a message of "toString" or "__proto__" is not a code we know.
  const known = Object.hasOwn(CODES, f.message) ? CODES[f.message] : undefined;
  const where = Object.hasOwn(PHASES, f.phase) ? PHASES[f.phase] : undefined;
  const plain =
    known ??
    (where ? `the updater stopped while ${where}` : "the updater stopped before it finished");
  return `The update to ${version} didn't install: ${plain}.`;
}
