// What a person sees after asking to check for updates (spec 40 M4): the words and choices for
// Settings > This Mac, and the line the menus and notifications show. One place, so the view and
// the menu bar say the same thing. Pure, for the tests.
import type { UpdateStatus } from "./rpc.ts";

export type CheckAction = "check" | "restart" | "restart-when-idle" | "restart-anyway" | "download";

export interface CheckView {
  /** What happened, or is happening; null before the first check. */
  line: string | null;
  /** A check is running: the check button is disabled and says so. */
  busy: boolean;
  /** "error" for a failed check, so the line reads as a problem. */
  tone: "normal" | "error";
  actions: { action: CheckAction; label: string; variant: "default" | "outline" | "destructive" }[];
}

const jobsText = (n: number) => `${n} job${n === 1 ? "" : "s"}`;

export function checkView(u: UpdateStatus): CheckView {
  const check = (label = "Check for updates") => ({
    action: "check" as const,
    label,
    variant: "outline" as const,
  });
  switch (u.phase) {
    case "off":
      return {
        line: u.reason ?? "Updates are off in this build.",
        busy: false,
        tone: "normal",
        actions: [],
      };
    case "checking":
      return { line: "Checking…", busy: true, tone: "normal", actions: [check("Checking…")] };
    case "downloading":
      return {
        line: `Downloading ${u.version ?? "the update"}…`,
        busy: true,
        tone: "normal",
        actions: [check("Downloading…")],
      };
    case "up-to-date":
      return {
        line: `You're up to date${u.installed ? ` (${u.installed})` : ""}`,
        busy: false,
        tone: "normal",
        actions: [check()],
      };
    case "failed":
      return {
        line: u.reason ?? u.error ?? "Couldn't check for updates.",
        busy: false,
        tone: "error",
        actions: [
          check("Try again"),
          ...(u.needsMove
            ? [
                {
                  action: "download" as const,
                  label: "Download the new version",
                  variant: "outline" as const,
                },
              ]
            : []),
        ],
      };
  }
  // The last update didn't install (Electrobun's helper said why; read after the relaunch). It is
  // never offered again as if nothing happened.
  const failed =
    u.installFailure && u.installFailure.version === u.version ? u.installFailure : null;
  if (u.ready && failed && u.waitingForRunner === null && u.jobs === 0)
    return {
      line: failed.reason,
      busy: false,
      tone: "error",
      actions: [{ action: "restart", label: "Retry the update", variant: "default" }],
    };
  if (u.ready) {
    // The same restart as the menu's (restart-update.ts): no job is cancelled unless chosen here.
    if (u.waitingForRunner !== null)
      return {
        line: `${u.version} is ready. Waiting for this Mac's runner to stop taking jobs…`,
        busy: true,
        tone: "normal",
        actions: [],
      };
    if (u.jobs === 0)
      return {
        line: `${u.version} is ready: Restart to update`,
        busy: false,
        tone: "normal",
        actions: [{ action: "restart", label: "Restart to update", variant: "default" }],
      };
    const jobs = jobsText(u.jobs);
    return {
      line: `${u.version} is ready. This Mac's runner is running ${jobs}: restarting now cancels them and their unpushed work is lost.`,
      busy: false,
      tone: "normal",
      actions: [
        {
          action: "restart-when-idle",
          label: `Restart when the ${jobs} finish`,
          variant: "default",
        },
        {
          action: "restart-anyway",
          label: `Restart now (cancels ${jobs})`,
          variant: "destructive",
        },
      ],
    };
  }
  if (u.installFailure)
    return { line: u.installFailure.reason, busy: false, tone: "error", actions: [check()] };
  return { line: null, busy: false, tone: "normal", actions: [check()] };
}

/** "Software Factory 0.1.4 (canary)", or what is known of it. */
export function installedText(u: Pick<UpdateStatus, "installed" | "channel">): string {
  if (!u.installed) return "Software Factory";
  return `Software Factory ${u.installed}${u.channel ? ` (${u.channel})` : ""}`;
}

/** "Last checked 5 minutes ago", or "Not checked yet". */
export function lastCheckedText(checkedAt: number | null, now = Date.now()): string {
  if (checkedAt === null) return "Not checked yet";
  const s = Math.max(0, Math.round((now - checkedAt) / 1000));
  if (s < 60) return "Last checked just now";
  const m = Math.round(s / 60);
  if (m < 60) return `Last checked ${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Last checked ${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `Last checked ${d} day${d === 1 ? "" : "s"} ago`;
}

/** What a notification says when a person checked from the menu with no window open. */
export function checkSummary(u: UpdateStatus): string {
  if (u.phase === "ready" || u.ready)
    return `${u.version} is ready: choose Restart to update in the menu bar.`;
  if (u.phase === "up-to-date")
    return `You're up to date${u.installed ? ` (${u.installed})` : ""}.`;
  if (u.phase === "failed") return u.reason ?? u.error ?? "Couldn't check for updates.";
  if (u.phase === "off") return u.reason ?? "Updates are off in this build.";
  return "Checking for updates…";
}
