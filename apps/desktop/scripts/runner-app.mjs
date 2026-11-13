// Builds SF Runner.app (spec 45 §1, ADR 0643) from the launcher, the pinned Node
// (scripts/vendor-node.mjs) and the sealed scripts (scripts/bundle-runner.mjs), and signs it:
// ad hoc by default (a dev build, whose launcher has no Team ID compiled in), or with a Developer
// ID identity and its Team ID for a release.
//
//   node scripts/runner-app.mjs --out <dir> [--version v --channel c --sha s]
//   SF_RUNNER_SIGN_IDENTITY="Developer ID Application: …" SF_RUNNER_TEAM=ABCDE12345 node scripts/runner-app.mjs --out <dir>
//
// `--launcher-team <id>` compiles a different Team ID into the launcher than the one the bundle is
// signed with (none, ad hoc): only the tests use it, for a bundle the launcher must refuse.
//
// Node is signed as nested code with its own identifier, V8's two entitlements and a launch
// constraint that only SF Runner's launcher may start it (its parent must be
// com.software-factory.runner, of the team when there is one). The launcher is signed with the
// hardened runtime and no entitlements; the bundle's seal covers every script.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SEALED } from "./bundle-runner.mjs";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(desktop, "native", "sf-runner-launcher");
export const BUNDLE_ID = "com.software-factory.runner";
export const NODE_ID = "com.software-factory.runner.node";

const plist = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
const str = (k, v) => `  <key>${k}</key>\n  <string>${v}</string>\n`;

export function infoPlist(version) {
  return plist(
    str("CFBundleIdentifier", BUNDLE_ID) +
      str("CFBundleName", "SF Runner") +
      str("CFBundleExecutable", "sf-runner") +
      str("CFBundlePackageType", "APPL") +
      str("CFBundleShortVersionString", version) +
      str("CFBundleVersion", version) +
      str("LSMinimumSystemVersion", "14.0") +
      "  <key>LSBackgroundOnly</key>\n  <true/>\n",
  );
}

/** The launch constraint on Node: its parent must be SF Runner's launcher (of `team`, if any). */
export function parentConstraint(team) {
  return plist(str("signing-identifier", BUNDLE_ID) + (team ? str("team-identifier", team) : ""));
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

/** Builds the launcher with `team` compiled in, in a copy of the package when there is one. */
function buildLauncher(team) {
  let dir = pkg;
  if (team) {
    dir = mkdtempSync(join(tmpdir(), "sf-runner-launcher-"));
    cpSync(pkg, dir, { recursive: true, filter: (p) => !p.includes(`${pkg}/.build`) });
    writeFileSync(
      join(dir, "Sources", "sf-runner", "Team.swift"),
      `let compiledTeam = "${team}"\n`,
    );
  }
  const triple = ["--triple", "arm64-apple-macosx14.0"];
  run("swift", ["build", "-c", "release", "--package-path", dir, ...triple]);
  const bin = execFileSync(
    "swift",
    ["build", "-c", "release", "--package-path", dir, ...triple, "--show-bin-path"],
    {
      encoding: "utf8",
    },
  ).trim();
  return join(bin, "sf-runner");
}

export function buildRunnerApp({
  out,
  version,
  channel,
  sha,
  identity = "-",
  team = "",
  launcherTeam = team,
}) {
  if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error("SF_RUNNER_TEAM is not a Team ID");
  if (launcherTeam && !/^[A-Z0-9]{10}$/.test(launcherTeam))
    throw new Error("--launcher-team is not a Team ID");
  if ((identity === "-") !== !team)
    throw new Error("a Team ID goes with a signing identity, and only then");
  const node = join(desktop, "vendor", "node");
  const scripts = join(desktop, "vendor", "runner-bundle");
  for (const need of [node, ...Object.keys(SEALED).map((s) => join(scripts, s))])
    if (!existsSync(need))
      throw new Error(
        `no ${need}: run scripts/vendor-node.mjs and scripts/bundle-runner.mjs --sealed`,
      );
  const launcher = buildLauncher(launcherTeam);

  const app = join(out, "SF Runner.app");
  rmSync(app, { recursive: true, force: true });
  const c = join(app, "Contents");
  for (const d of ["MacOS", "Helpers", "Resources/runner"])
    mkdirSync(join(c, d), { recursive: true });
  cpSync(launcher, join(c, "MacOS", "sf-runner"));
  cpSync(node, join(c, "Helpers", "node"));
  for (const s of Object.keys(SEALED)) cpSync(join(scripts, s), join(c, "Resources", "runner", s));
  cpSync(
    join(desktop, "..", "..", "local", "runner-host", "src", "launcher-entries.json"),
    join(c, "Resources", "launcher-entries.json"),
  );
  writeFileSync(join(c, "Info.plist"), infoPlist(version));
  writeFileSync(
    join(c, "Resources", "version.json"),
    `${JSON.stringify({ version, channel, sha, runnerSha: null, runnerSeq: null, compat: null, contract: null })}\n`,
  );

  const work = mkdtempSync(join(tmpdir(), "sf-runner-sign-"));
  const constraint = join(work, "parent.plist");
  writeFileSync(constraint, parentConstraint(team));
  const timestamp = identity === "-" ? [] : ["--timestamp"];
  run("codesign", [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    ...timestamp,
    "--identifier",
    NODE_ID,
    "--entitlements",
    join(pkg, "node.entitlements"),
    "--launch-constraint-parent",
    constraint,
    join(c, "Helpers", "node"),
  ]);
  run("codesign", ["--force", "--sign", identity, "--options", "runtime", ...timestamp, app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  rmSync(work, { recursive: true, force: true });
  const mismatch = launcherTeam !== team ? `, launcher expects ${launcherTeam}` : "";
  console.log(`runner-app: ${app} (${team ? `team ${team}` : "ad hoc"}${mismatch})`);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      version: { type: "string", default: "0.0.0-dev" },
      channel: { type: "string", default: "dev" },
      sha: { type: "string", default: "unknown" },
      "launcher-team": { type: "string" },
    },
  });
  if (!values.out) throw new Error("--out <dir> is required");
  buildRunnerApp({
    out: values.out,
    version: values.version,
    channel: values.channel,
    sha: values.sha,
    identity: process.env.SF_RUNNER_SIGN_IDENTITY || "-",
    team: process.env.SF_RUNNER_TEAM || "",
    launcherTeam: values["launcher-team"] ?? (process.env.SF_RUNNER_TEAM || ""),
  });
}
