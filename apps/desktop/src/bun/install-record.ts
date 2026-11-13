// Keeping Electrobun's install record true, and saying when an update didn't install (spec 40 M4).
//
// Electrobun 2.0.6 keeps an install record per channel, `<channel root>/.electrobun-uninstall.json`
// (the channel root is ~/Library/Application Support/<identifier>/<channel>), with a copy of its
// update helper beside it (`uninstall`). Applying an update, the helper (extractor/main.zig,
// apply-update's validating phase) refuses with InvalidUpdateIdentity unless the record's
// `app_bundle_path` is exactly the running app's bundle. The record is written only when
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
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isNewer } from "../shared/version.ts";
import type { Exec } from "./update-verify.ts";

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
}

export type RecordVerdict =
  | { action: "ok" }
  | { action: "bootstrap"; why: "missing" | "unreadable" | "moved"; recorded?: string };

/** Whether the install record must be rewritten for the running bundle. Pure, for the tests. */
export function recordVerdict(f: RecordFacts): RecordVerdict {
  if (f.record === null || !f.helper) return { action: "bootstrap", why: "missing" };
  let recorded: unknown;
  try {
    recorded = (JSON.parse(f.record) as Record<string, unknown>).app_bundle_path;
  } catch {
    return { action: "bootstrap", why: "unreadable" };
  }
  if (typeof recorded !== "string") return { action: "bootstrap", why: "unreadable" };
  if (recorded !== f.appPath) return { action: "bootstrap", why: "moved", recorded };
  return { action: "ok" };
}

export interface RecordDeps {
  exec: Exec;
  read?: (p: string) => string | null;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
  log?: (line: string) => void;
}

/**
 * Makes the install record name the running bundle (see above). Never throws: an update that still
 * can't install says so after the relaunch. Returns what it did, for the log and the tests.
 */
export async function syncInstallRecord(
  channelRoot: string,
  appPath: string,
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
    });
    if (verdict.action === "ok") return verdict;
    const helper = join(app, "Contents", "Resources", "uninstall");
    const r = await deps.exec(helper, ["--bootstrap-install", channelRoot, "--quiet"]);
    if (r.code !== 0) {
      const error = `install record (${verdict.why}): the helper exited ${r.code}: ${r.out.trim().slice(-300)}`;
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

/** One update attempt's outcome, as Electrobun's helper wrote it. */
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
  /** Electrobun's own words (InvalidUpdateIdentity, …), for the log. */
  message: string;
  phase: string;
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

/** The helper's result files in the channel root (a bounded, plain-file read). */
export function readUpdateResults(channelRoot: string, limit = 20): UpdateResult[] {
  const out: UpdateResult[] = [];
  let names: string[];
  try {
    names = readdirSync(channelRoot).filter((n) => RESULT_FILE.test(n));
  } catch {
    return out;
  }
  for (const name of names.slice(0, limit)) {
    const path = join(channelRoot, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > 16_384) continue;
      const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const { success, phase, message, version } = doc;
      if (
        typeof success !== "boolean" ||
        typeof phase !== "string" ||
        typeof message !== "string" ||
        typeof version !== "string"
      )
        continue;
      out.push({ success, phase, message, version, modifiedAt: st.mtimeMs });
    } catch {
      // Not a result this app can read: left alone.
    }
  }
  return out;
}

/** Electrobun's failure codes in plain words, for a person. */
export function plainInstallFailure(f: InstallFailure): string {
  const why: Record<string, string> = {
    InvalidUpdateIdentity:
      "the updater's record of where the app is installed named another copy (the app was moved after it was first opened)",
    InvalidUpdatePath: "the app wasn't where the updater expected it",
  };
  const plain =
    why[f.message] ?? `the updater stopped while ${f.phase.replace(/_/g, " ")} (${f.message})`;
  return `The update to ${f.version} didn't install: ${plain}.`;
}
