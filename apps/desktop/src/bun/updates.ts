// Updates (spec 40 M4, ADR 0390): signed canary and stable builds on downloads.zerobsai.com.
// Electrobun's Updater reads `<channel>-macos-arm64-update-v2.json` from the build's release
// baseUrl, downloads and stages a new version in the background. This class decides whether that
// version may be applied. It is offered only when all of these hold:
// - the manifest's version is higher than the running one (no downgrades, even to a build whose
//   hash merely differs, which is all Electrobun checks);
// - Electrobun really staged it (its download swallows errors: its own state is read back, and a
//   failed download is tried again later);
// - the staged bundle is signed by this build's Team ID and passes Gatekeeper (update-verify.ts).
//   That takes seconds (spctl asks Apple's notary service), so it is done once the download lands,
//   and the bundle's content hash (bundleFingerprint) is recorded with it, taken before and after
//   the checks. Right before applying the hash is taken again: equal means the bundle applied is
//   the one checked. A different hash means the bundle changed on disk: it is counted, logged,
//   discarded and downloaded again, and the person is told so. Another staging folder, or a check
//   more than VERIFIED_FOR_MS old, is checked in full again. So a certificate revoked between the
//   download and the click is noticed only by a full check: at the next download, or at the click
//   once the last full check is a day old (spec 40 M4);
// - the staged bundle's own version.json (inside that seal) says the manifest's version, newer than
//   the running one, on this build's channel: the manifest alone can't vouch for an old build;
// - the app sits where it can replace itself (not translocated, its folder writable). If it can't,
//   the person is told to move it to Applications.
// Applying restarts the app, so it waits for the person, and for the runner's jobs (index.ts).
// Dev builds and unsigned builds never update: they say so ("off"), they don't fail.
// A person can ask for a check (Check for Updates…, Settings > This Mac): `checkByPerson` is not
// held back by ON_DEMAND_GAP_MS, only by a check already running (every trigger shares one check
// in flight), and it never downloads again what is already staged or skips a check above.
// Electrobun's install record must name this bundle or the update fails after the restart
// (InvalidUpdateIdentity): it is put right at start and again before applying (install-record.ts).
// An update that didn't install says so after the relaunch, and isn't offered as if new.
// Nothing here imports Electrobun, so the tests run on Node.
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { CheckPhase } from "../shared/rpc.ts";
import { isNewer } from "../shared/version.ts";
import {
  type InstallFailure,
  lastFailure,
  plainInstallFailure,
  readUpdateResults,
  syncInstallRecord,
  type UpdateResult,
} from "./install-record.ts";
import type { ApplyGate } from "./restart-update.ts";
import type { Exec, StagedUpdate } from "./update-verify.ts";
import {
  bundleFingerprint,
  bundleInfo,
  discardStaged,
  stagedBundle,
  stagedUpdate,
  teamIdOf,
  verifyBundle,
} from "./update-verify.ts";

export interface UpdateState {
  /** A verified update is staged: "Restart to update" can be offered. */
  ready: boolean;
  /** The version that is ready (or was refused). */
  version: string | null;
  /** Why the last check didn't end ready, for the menu and the logs. */
  error: string | null;
  /** The app can't update where it is: tell the person to move it to Applications. */
  needsMove: boolean;
  /** Where the latest check is, or what it found: what a person who asked is shown. */
  phase: CheckPhase;
  /** When a check last finished (epoch ms), or null. */
  checkedAt: number | null;
  /** The running build's version and channel, once read. */
  installed: string | null;
  channel: string | null;
  /** `error` in plain words for a person (failed, off, or the app must move); null otherwise. */
  reason: string | null;
  /** The last update didn't install (read after the relaunch): its version and why, in plain words. */
  installFailure?: { version: string; reason: string } | null;
}

/** What this class uses of Electrobun's Updater (src/sdks/main/core/Updater.ts). */
export interface UpdaterLike {
  checkForUpdate(): Promise<{
    version: string;
    updateAvailable: boolean;
    /** This version is already prepared: nothing to download. */
    updateReady?: boolean;
    error: string;
  }>;
  downloadUpdate(): Promise<void>;
  updateInfo(): { version: string; updateReady: boolean; error: string };
  applyUpdate(): Promise<void>;
  getLocalInfo(): Promise<{ version: string; channel: string }>;
  appDataFolder(): Promise<string>;
}

export interface UpdatesDeps {
  updater: UpdaterLike;
  exec: Exec;
  /** The running .app. */
  appPath: string;
  /** The clock, for when a check finished. */
  now?: () => number;
  /**
   * A monotonic clock (ms), for how old the last full check is: it lives only in memory, so a wall
   * clock set back (or forward) can't make it look fresher than it is.
   */
  monotonic?: () => number;
  /** Throws when `path` isn't writable (fs.accessSync with W_OK). */
  writable?: (path: string) => void;
  staged?: (appDataFolder: string) => StagedUpdate | null;
  /** The version and channel in a bundle's own Resources/version.json. */
  bundle?: (app: string) => { version: string; channel: string } | null;
  setInterval?: (fn: () => void, ms: number) => unknown;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Makes Electrobun's install record name this bundle (install-record.ts). */
  syncRecord?: (channelRoot: string, appPath: string, channel: string) => Promise<unknown>;
  /** A bundle's content hash (bundleFingerprint). */
  fingerprint?: (app: string) => Promise<string>;
  /** Removes a staged update (its prepared record and staging folder) so it is downloaded again. */
  discard?: (appDataFolder: string, stagingPath: string) => void;
  /** The update helper's results in the channel root. */
  results?: (channelRoot: string) => UpdateResult[];
  log?: (line: string) => void;
}

export const EVERY_MS = 6 * 3_600_000;
/** After a failed check or download. */
export const RETRY_MS = 30 * 60_000;
/** The door's update_required asks for a check at most this often (ADR 0393). */
export const ON_DEMAND_GAP_MS = 10 * 60_000;
/** A full check (signature, Gatekeeper) older than this is done again at the click, not just the hash. */
export const VERIFIED_FOR_MS = 24 * 3_600_000;
/** The error for a staged bundle whose content hash changed after it was checked. */
export const CHANGED_ON_DISK = "refused: the staged update changed on disk after it was checked";

export const OFF_DEV = "Updates are off in this build (a development build).";
export const OFF_UNSIGNED =
  "Updates are off in this build: it isn't signed, so it can't check an update's signature.";

const MOVE =
  "Move Software Factory to your Applications folder (and open it from there) to get updates.";

/** Why the app can't replace itself where it is, or null. */
export function installProblem(appPath: string, writable: (p: string) => void): string | null {
  // Gatekeeper runs a quarantined app opened from Downloads from a random read-only copy.
  if (appPath.includes("/AppTranslocation/")) return MOVE;
  try {
    // Electrobun stages the new version beside the app and swaps it in.
    writable(dirname(appPath));
    writable(appPath);
    return null;
  } catch {
    return `This Mac's account can't replace the app where it is. ${MOVE}`;
  }
}

export class Updates {
  state: UpdateState = {
    ready: false,
    version: null,
    error: null,
    needsMove: false,
    phase: "idle",
    checkedAt: null,
    installed: null,
    channel: null,
    reason: null,
  };
  private retry: unknown = null;
  /** The check running now, shared by every trigger. */
  private inFlight: Promise<void> | null = null;
  /** Why this build takes no updates (dev, unsigned), or null; read once. */
  private offWhy: Promise<string | null> | null = null;
  private lastOnDemand = Number.NEGATIVE_INFINITY;
  /** The staged bundle that passed every check, and its content hash then. */
  private verified: {
    stagingPath: string;
    bundle: string;
    version: string;
    fingerprint: string;
    /** When the full check passed, on the monotonic clock (`monotonic`). */
    at: number;
    /** And on the wall clock (epoch ms): the monotonic one may not advance while the Mac sleeps. */
    wallAt: number;
  } | null = null;
  /** How many times a checked bundle's hash differed at the click, this session (logged each time). */
  hashMismatches = 0;
  private readonly d: Required<UpdatesDeps>;

  constructor(
    deps: UpdatesDeps,
    private readonly onChange: (s: UpdateState) => void,
  ) {
    this.d = {
      writable: (p) => accessSync(p, constants.W_OK),
      staged: (f) => stagedUpdate(f),
      bundle: (a) => bundleInfo(a),
      setInterval: (fn, ms) => setInterval(fn, ms),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      now: () => Date.now(),
      monotonic: () => performance.now(),
      syncRecord: (root, app, channel) =>
        syncInstallRecord(root, app, channel, { exec: deps.exec }),
      discard: (folder, staging) => discardStaged(folder, staging, deps.appPath),
      results: (root) => readUpdateResults(root),
      fingerprint: (app) => bundleFingerprint(app),
      log: (line) => console.log(line),
      ...deps,
    };
  }

  /**
   * Null when this build can update; else why not, in plain words. A dev build never updates, and an
   * unsigned one can't check an update's signature (verifyStaged would refuse every update anyway).
   * Read once: the running build doesn't change.
   */
  private offReason(): Promise<string | null> {
    this.offWhy ??= (async () => {
      const local = await this.d.updater.getLocalInfo();
      this.set({ installed: local.version, channel: local.channel });
      if (local.channel === "dev") return OFF_DEV;
      if (!(await teamIdOf(this.d.appPath, this.d.exec))) return OFF_UNSIGNED;
      return null;
    })().catch(() => {
      this.offWhy = null; // not known yet: ask again next time
      return null;
    });
    return this.offWhy;
  }

  /** Off builds say so instead of checking. True when this build may check. */
  private async mayCheck(): Promise<boolean> {
    const off = await this.offReason();
    if (off) this.set({ phase: "off", reason: off, error: null });
    return !off;
  }

  async start(): Promise<void> {
    if (!(await this.mayCheck())) return;
    await this.prepareInstall();
    await this.check();
    this.d.setInterval(() => void this.check(), EVERY_MS);
  }

  /**
   * The door said this build is too old (ADR 0393): check now, but at most once every
   * ON_DEMAND_GAP_MS, however many requests are refused. Dev builds never update.
   */
  async checkNow(now = Date.now()): Promise<void> {
    if (now - this.lastOnDemand < ON_DEMAND_GAP_MS) return;
    this.lastOnDemand = now;
    if (!(await this.mayCheck())) return;
    await this.check();
  }

  /**
   * A person asked (Check for Updates…, Settings): check now, with no gap, joining a check already
   * running rather than starting a second. An update already staged is reported as ready, not
   * downloaded again. Every check below still applies.
   */
  async checkByPerson(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!(await this.mayCheck())) return;
    if (this.state.ready) return this.set({ phase: "ready", reason: null });
    await this.check();
  }

  /**
   * Before any update is prepared: make the install record name this bundle, and read whether the
   * last update installed. A translocated app is left alone (it is told to move first).
   */
  private async prepareInstall(): Promise<void> {
    try {
      if (installProblem(this.d.appPath, this.d.writable)) return;
      const root = await this.d.updater.appDataFolder();
      const local = await this.d.updater.getLocalInfo();
      await this.d.syncRecord(root, this.d.appPath, local.channel);
      const running = local.version;
      const failed: InstallFailure | null = lastFailure(this.d.results(root), running);
      if (failed) {
        this.d.log(
          `updates: the update to ${failed.version} didn't install (${failed.phase}: ${failed.message})`,
        );
        this.set({
          installFailure: { version: failed.version, reason: plainInstallFailure(failed) },
        });
      }
    } catch (error) {
      this.d.log(`updates: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  private fail(error: string, version: string | null = this.state.version, retry = true) {
    this.set({
      ready: false,
      version,
      error,
      phase: "failed",
      reason: plainReason(error, this.state.installed),
      checkedAt: this.d.now(),
    });
    if (retry && !this.retry) {
      this.retry = this.d.setTimeout(() => {
        this.retry = null;
        void this.check();
      }, RETRY_MS);
    }
  }

  /** One check at a time: a trigger that lands while one runs joins it. */
  check(): Promise<void> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    if (this.state.ready) return;
    const { updater } = this.d;
    this.set({ phase: "checking" });
    try {
      const problem = installProblem(this.d.appPath, this.d.writable);
      if (problem)
        return this.set({
          ready: false,
          error: problem,
          needsMove: true,
          phase: "failed",
          reason: problem,
          checkedAt: this.d.now(),
        });
      if (this.state.needsMove) this.set({ needsMove: false, error: null });

      const info = await updater.checkForUpdate();
      if (info.error) return this.fail(info.error);
      if (!info.updateAvailable) {
        const running = (await updater.getLocalInfo()).version;
        return this.set({
          ready: false,
          version: null,
          error: null,
          phase: "up-to-date",
          reason: null,
          installed: running,
          checkedAt: this.d.now(),
        });
      }
      const running = (await updater.getLocalInfo()).version;
      if (!isNewer(info.version, running)) {
        // Not retried: the bucket would have to publish a higher version first.
        return this.fail(
          `refused ${info.version}: not newer than this version (${running})`,
          info.version,
          false,
        );
      }

      // Electrobun skips the download when this version is already prepared (updateReady).
      this.set({ phase: "downloading", version: info.version });
      if (!info.updateReady) await updater.downloadUpdate();
      const after = updater.updateInfo();
      if (!after.updateReady) {
        return this.fail(after.error || "the download didn't finish", info.version);
      }
      const why = await this.verifyStaged();
      if (why) return this.fail(why, info.version, false);
      this.set({
        ready: true,
        version: info.version,
        error: null,
        phase: "ready",
        reason: null,
        checkedAt: this.d.now(),
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Null when the staged update may be applied now; else why not (and the state says so, in plain
   * words). Cheap when the staged bundle is, by its content hash, the one checked at download.
   */
  async verifyForApply(gate?: Pick<ApplyGate, "cancelled">): Promise<string | null> {
    const why = await this.recheck();
    if (why) {
      // Given up on while it was checked (restart-update.ts's watchdog): the window already says
      // the app didn't restart, and that stays what it says.
      if (gate?.cancelled()) {
        this.d.log(`updates: the cancelled restart's check failed afterwards: ${why}`);
        return why;
      }
      this.fail(why, this.state.version, false);
      // Discarded above: fetched again now, and checked in full when it lands.
      if (why === CHANGED_ON_DISK) void this.check();
    }
    return why;
  }

  private async recheck(): Promise<string | null> {
    const v = this.verified;
    if (v) {
      this.verified = null;
      try {
        // Stale by either clock: the monotonic one may stand still while the Mac sleeps, and the
        // wall clock can be set back. A negative age on either is treated as stale too.
        const age = this.d.monotonic() - v.at;
        const wall = this.d.now() - v.wallAt;
        if (age < 0 || age > VERIFIED_FOR_MS || wall < 0 || wall > VERIFIED_FOR_MS) {
          this.d.log(
            `updates: ${v.version} was checked ${Math.round(Math.max(age, wall) / 3_600_000)} h ago: checking it in full again`,
          );
          return this.verifyStaged();
        }
        const folder = await this.d.updater.appDataFolder();
        const running = (await this.d.updater.getLocalInfo()).version;
        const staged = this.d.staged(folder);
        if (
          staged !== null &&
          staged.path === v.stagingPath &&
          staged.version === v.version &&
          isNewer(v.version, running)
        ) {
          if ((await this.d.fingerprint(v.bundle)) === v.fingerprint) {
            this.verified = v;
            return null;
          }
          // The bundle checked isn't the bundle on disk any more: never applied, never silently
          // checked again. Counted and logged, then discarded and downloaded again.
          this.hashMismatches++;
          this.d.log(
            `updates: the staged ${v.version} changed on disk after it was checked (hash mismatch ${this.hashMismatches} this session): discarding it and downloading it again`,
          );
          try {
            this.d.discard(folder, v.stagingPath);
          } catch (error) {
            this.d.log(
              `updates: couldn't discard the staged ${v.version}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          this.set({ ready: false });
          return CHANGED_ON_DISK;
        }
      } catch {
        // Unreadable: checked in full below.
      }
    }
    return this.verifyStaged();
  }

  /** Null when the staged update may be applied; else why not. Checks it all, in full. */
  private async verifyStaged(): Promise<string | null> {
    this.verified = null;
    const local = await this.d.updater.getLocalInfo();
    const running = local.version;
    const staged = this.d.staged(await this.d.updater.appDataFolder());
    if (!staged) return "refused: no staged update this app can check";
    if (!isNewer(staged.version, running))
      return `refused ${staged.version}: not newer than this version (${running})`;
    const team = await teamIdOf(this.d.appPath, this.d.exec);
    if (!team) return "refused: this build isn't signed, so it can't check an update's signature";
    const bundle = stagedBundle(staged.path, this.d.appPath);
    const t0 = this.d.now();
    const before = await this.d.fingerprint(bundle).catch(() => null);
    const t1 = this.d.now();
    const why = await verifyBundle(bundle, team, this.d.exec);
    const t2 = this.d.now();
    if (why) return `refused ${staged.version}: ${why}`;
    const after = await this.d.fingerprint(bundle).catch(() => null);
    this.d.log(
      `updates: checked ${staged.version}: signature and Gatekeeper ${t2 - t1} ms, content hash ${t1 - t0} ms`,
    );
    // Read only now, from inside the seal just verified: the manifest's version is the bucket's word.
    const own = this.d.bundle(bundle);
    if (!own) return `refused ${staged.version}: the staged app has no readable version`;
    if (own.version !== staged.version)
      return `refused ${staged.version}: the staged app is version ${own.version}, not what the manifest says`;
    if (!isNewer(own.version, running))
      return `refused ${own.version}: not newer than this version (${running})`;
    if (own.channel !== local.channel)
      return `refused ${own.version}: it is a ${own.channel} build, this is ${local.channel}`;
    // Unchanged while it was checked: remembered, so applying it only hashes it again.
    if (before !== null && before === after)
      this.verified = {
        stagingPath: staged.path,
        bundle,
        version: staged.version,
        fingerprint: before,
        at: this.d.monotonic(),
        wallAt: this.d.now(),
      };
    return null;
  }

  /**
   * Restarts into the staged version, checked once more first. Returns only when that didn't
   * happen (nothing staged, a refused signature, or a quit handler said no): the caller then
   * brings back whatever it stopped. The reason is in `state.error`.
   */
  async apply(gate?: ApplyGate): Promise<void> {
    await this.prepareInstall();
    if (await this.verifyForApply(gate)) return;
    // The last moment to stop: past here the helper may replace the app. A restart that was given
    // up on (restart-update.ts's watchdog) has already brought everything back and said so.
    if (gate && !gate.handoff()) {
      this.d.log("updates: restart to update was given up on before the handoff: not applying");
      return;
    }
    await this.d.updater.applyUpdate();
    // Still here: Electrobun didn't restart.
    const after = this.d.updater.updateInfo();
    const error = after.error || "the update didn't start; try again from the menu";
    this.set({
      ready: after.updateReady,
      error,
      phase: after.updateReady ? "ready" : "failed",
      reason: after.updateReady ? null : plainReason(error, this.state.installed),
    });
  }
}

const NETWORK =
  /fetch failed|unable to connect|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|network|timed out|timeout|offline|internet/i;

/** An updater error in plain words for a person (the raw one goes to the log). */
export function plainReason(error: string, running: string | null = null): string {
  const refused = /^refused(?: (\S+?))?: (.*)$/s.exec(error);
  if (refused) {
    const [, version, why = ""] = refused;
    const which = version ? `Version ${version}` : "The update";
    if (/changed on disk/.test(why))
      return "The downloaded update changed on disk: downloading it again.";
    if (/not newer/.test(why))
      return `${which} was refused: it isn't newer than this version${running ? ` (${running})` : ""}.`;
    if (/isn't signed/.test(why)) return OFF_UNSIGNED;
    if (/signature/.test(why)) return `${which} was refused: its signature didn't check out.`;
    if (/Gatekeeper/.test(why)) return `${which} was refused: macOS Gatekeeper rejected it.`;
    if (/manifest says|no readable version/.test(why))
      return `${which} was refused: it isn't the version the update server said it was.`;
    if (/ build, this is /.test(why))
      return `${which} was refused: it is for another channel (${why.replace(/^it is an? /, "")}).`;
    return `${which} was refused: ${why}`;
  }
  if (NETWORK.test(error))
    return "Couldn't reach the update server. Check that this Mac is online, then try again.";
  if (/Failed to check for updates|update\.json|manifest/i.test(error)) {
    const http = /HTTP \d{3}/.exec(error)?.[0];
    return `Couldn't read the update server's list of versions${http ? ` (${http})` : ""}.`;
  }
  if (/download/i.test(error)) return "The update couldn't be downloaded. Try again in a while.";
  return error;
}
