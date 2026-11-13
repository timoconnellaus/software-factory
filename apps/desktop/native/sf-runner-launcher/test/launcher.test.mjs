// SF Runner.app's launcher against a real bundle (spec 45 criteria 1, 2 and 2a, the bundle half).
// macOS only. CI runs it on an ad-hoc build (the launcher compiled with no Team ID), and the
// release on the Developer ID-signed, notarized bundle:
//
//   node apps/desktop/scripts/vendor-node.mjs && node apps/desktop/scripts/bundle-runner.mjs --sealed
//   node apps/desktop/scripts/runner-app.mjs --out "$dir"
//   SF_RUNNER_APP="$dir/SF Runner.app" node --test apps/desktop/native/sf-runner-launcher/test/
//
// With SF_RUNNER_APP_OTHER_TEAM set, it also checks a bundle whose launcher has a Team ID compiled
// in that the bundle isn't signed with (runner-app.mjs --launcher-team): CI's is ad hoc, the
// release's is signed with the real identity.
//
// Each tamper case works on its own copy of the bundle. The launcher takes the home folder from
// getpwuid, not HOME, so a refusal writes `<stateDir>/service/launch-refused.json` in the account's
// real home: the tests put back whatever was there (or nothing) when they finish. Only on CI do
// they plant in the home folder itself (`~/.node_modules`, `~/.node_libraries`).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const APP = process.env.SF_RUNNER_APP;
const OTHER_TEAM = process.env.SF_RUNNER_APP_OTHER_TEAM;
const skip = process.platform !== "darwin" || !APP ? "macOS, with SF_RUNNER_APP set" : false;
const LAUNCHER = "Contents/MacOS/sf-runner";

// launch-refused.json under the account's home (LauncherCore's stateDir), kept and put back.
const REFUSED = join(homedir(), ".local/state/software-factory/runner/service/launch-refused.json");
let refusedBefore = null;
before(() => {
  refusedBefore = existsSync(REFUSED) ? readFileSync(REFUSED) : null;
});
after(() => {
  if (refusedBefore) writeFileSync(REFUSED, refusedBefore);
  else rmSync(REFUSED, { force: true });
});

/** A fresh copy of the bundle under `parent` (made if missing). */
function copy(parent = mkdtempSync(join(tmpdir(), "sf-launcher-"))) {
  mkdirSync(parent, { recursive: true });
  const app = join(parent, "SF Runner.app");
  execFileSync("ditto", [APP, app]);
  // A release copy is read-only (spec 45 §2); the tamper cases need to write to theirs.
  execFileSync("chmod", ["-R", "u+w", app]);
  return app;
}

function launch(app, args = [], opts = {}) {
  return spawnSync(join(app, LAUNCHER), args, { encoding: "utf8", timeout: 30_000, ...opts });
}

const selftest = (app, opts) => launch(app, ["selftest"], opts);

/** Whether the bundle is signed by a team (a release build) rather than ad hoc. */
const teamSigned = (() => {
  if (skip) return false;
  const r = spawnSync("codesign", ["-dv", APP], { encoding: "utf8" });
  return /^TeamIdentifier=[A-Z0-9]{10}$/m.test(r.stderr);
})();
const macosMajor = Number(
  spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout?.split(".")[0],
);

/** A line for the job summary, as well as the log. */
function record(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

test("an untouched bundle runs its self-test with exactly the environment and flags of §1", {
  skip,
}, () => {
  const r = selftest(APP, {
    // Not Node's working directory: the launcher sets "/" (§1, step 6).
    cwd: mkdtempSync(join(tmpdir(), "sf-launcher-cwd-")),
    env: {
      ...process.env,
      NODE_OPTIONS: "--require /tmp/sf-planted.js",
      NODE_PATH: "/tmp",
      // The hardened runtime makes dyld ignore DYLD_* for the launcher itself only when it is
      // team-signed: on macOS 15 an ad-hoc launcher still loads an inserted library (found by
      // this test in CI), so an ad-hoc run checks a harmless DYLD_* variable instead.
      ...(teamSigned
        ? { DYLD_INSERT_LIBRARIES: "/tmp/sf-planted.dylib" }
        : { DYLD_FALLBACK_LIBRARY_PATH: "/tmp" }),
      NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
      PATH: "/nowhere",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
  const keys = out.envKeys.filter((k) => k !== "__CF_USER_TEXT_ENCODING");
  assert.deepEqual(keys, [
    "HOME",
    "LOGNAME",
    "PATH",
    "SF_RUNNER_BUNDLE",
    "SF_RUNNER_LIFELINE_FD",
    "SF_RUNNER_ROOT",
    "SF_RUNNER_SERVICE",
    "SHELL",
    "TMPDIR",
    "USER",
  ]);
  assert.deepEqual(out.execArgv, ["--disable-sigusr1", "--no-addons"]);
  assert.deepEqual(out.argv, ["/dev/fd/4", "--selftest"]);
  assert.equal(out.cwd, "/");
  assert.equal(out.bundle, realpathSync(APP));
  // A release launcher has its Team ID compiled in: one that logs `unsigned build` is a dev build.
  if (teamSigned)
    assert.doesNotMatch(r.stderr, /unsigned build/, "a release launcher built for ad hoc");
  else assert.match(r.stderr, /unsigned build/);
});

test("Node gets none of the launcher's other descriptors", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-launcher-fds-"));
  const marker = join(dir, "marker");
  writeFileSync(marker, "x");
  // Descriptors open in the launcher on a file the test can recognise by its inode: fd 3 alone
  // (then the launcher's first pipe once landed on fd 4 itself, stayed close-on-exec, and Node
  // read a pipe of its own there: a hang), and 3 to 12 (past where it puts the script, 4, and the
  // lifeline, 5).
  for (const count of [1, 10]) {
    const fds = Array.from({ length: count }, () => openSync(marker, "r"));
    const { ino } = fstatSync(fds[0]);
    try {
      const r = selftest(APP, { stdio: ["pipe", "pipe", "pipe", ...fds], timeout: 10_000 });
      assert.equal(r.status, 0, `fds 3-${2 + count}: ${r.signal ?? ""} ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      const leaked = out.fds.filter((f) => f.ino === ino);
      assert.deepEqual(leaked, [], "a descriptor the launcher was given reached Node");
      assert.deepEqual(out.argv, ["/dev/fd/4", "--selftest"]);
    } finally {
      for (const fd of fds) closeSync(fd);
    }
  }
});

const tampers = {
  "a changed byte in sf-runner.cjs": (app) =>
    appendFileSync(join(app, "Contents/Resources/runner/sf-runner.cjs"), "\n"),
  "an added script in Resources/runner": (app) =>
    writeFileSync(join(app, "Contents/Resources/runner/extra.cjs"), "console.log(1)\n"),
  "a changed version.json": (app) =>
    writeFileSync(join(app, "Contents/Resources/version.json"), '{"version":"9.9.9"}\n'),
  "a changed entry table": (app) =>
    appendFileSync(join(app, "Contents/Resources/launcher-entries.json"), " "),
  "a replaced Helpers/node": (app) => {
    const node = join(app, "Contents/Helpers/node");
    cpSync(process.execPath, node);
    execFileSync(
      "codesign",
      ["--force", "--sign", "-", "--identifier", "com.software-factory.runner.node", node],
      {
        stdio: "ignore",
      },
    );
  },
};

for (const [name, tamper] of Object.entries(tampers)) {
  test(`the launcher refuses ${name} (78) and Node never starts`, { skip }, () => {
    const app = copy();
    tamper(app);
    for (const args of [[], ["selftest"], ["runner"], ["check-child"]]) {
      const r = launch(app, args, { input: "" });
      assert.equal(r.status, 78, `${args}: ${r.stderr}`);
      assert.match(r.stderr, /refused: /);
      assert.equal(r.stdout, "");
    }
  });
}

test("a refusal is recorded in launch-refused.json with its reason and bundle (§1, step 7)", {
  skip,
}, () => {
  const app = copy();
  appendFileSync(join(app, "Contents/Resources/runner/service.cjs"), "\n");
  const since = Date.now() - 1000;
  const r = launch(app, ["selftest"]);
  assert.equal(r.status, 78, r.stderr);
  const record = JSON.parse(readFileSync(REFUSED, "utf8"));
  assert.equal(record.bundle, realpathSync(app));
  assert.match(record.reason, /seal/);
  assert.ok(r.stderr.includes(`refused: ${record.reason}`), r.stderr);
  assert.ok(Date.parse(record.at) >= since - 1000, record.at);
});

test("a launcher with another Team ID compiled in refuses the bundle (78)", {
  skip: skip || (!OTHER_TEAM && "SF_RUNNER_APP_OTHER_TEAM not set"),
}, () => {
  for (const args of [[], ["selftest"], ["runner"]]) {
    const r = launch(OTHER_TEAM, args, { input: "" });
    record(`launcher with another Team ID, ${args.join(" ") || "(guard)"}: exit ${r.status}`);
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /refused: /);
    assert.doesNotMatch(r.stderr, /unsigned build/);
    assert.equal(r.stdout, "");
  }
});

test("a team-signed bundle, tampered with and re-signed ad hoc as a whole, is refused (78)", {
  skip: skip || (!teamSigned && "needs a team-signed bundle (the release's prototype step)"),
}, () => {
  const app = copy();
  appendFileSync(join(app, "Contents/Resources/runner/service.cjs"), "\n");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  const r = selftest(app);
  record(`team-signed bundle re-signed ad hoc: exit ${r.status}`);
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /refused: /);
  assert.equal(r.stdout, "");
});

test("a path, an unknown entry or extra arguments exit 64 before Node", { skip }, () => {
  for (const args of [
    ["/tmp/x.js"],
    ["./sf-runner.cjs"],
    ["nope"],
    ["runner", "runner"],
    ["selftest", "--inspect"],
    ["run"],
    // Over 2 KiB, end to end (the grammar's own tests cover the boundary).
    ["login", "--name", "m5", "--url", `https://e.example.com/${"a".repeat(2100)}`],
    // A name with a trailing newline: NSRegularExpression's `$` would have let it through.
    ["login", "--name", "m5\n", "--url", "https://engine.example.com"],
  ]) {
    const r = launch(APP, args);
    assert.equal(r.status, 64, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    // Refused before the bundle is checked, so before Node.
    assert.doesNotMatch(r.stderr, /unsigned build|refused/);
  }
});

test("started through a symlink, or with argv[0] naming another bundle, it runs its own", {
  skip,
}, () => {
  const other = copy();
  writeFileSync(join(other, "Contents/Resources/runner/sf-runner.cjs"), "console.log('other')\n");
  const dir = mkdtempSync(join(tmpdir(), "sf-launcher-link-"));
  const link = join(dir, "sf-runner");
  symlinkSync(join(APP, LAUNCHER), link);
  const viaLink = spawnSync(link, ["selftest"], { encoding: "utf8" });
  assert.equal(viaLink.status, 0, viaLink.stderr);
  const real = realpathSync(APP);
  // The bundle it validated (and Node's SF_RUNNER_BUNDLE) is its own resolved path, not the
  // link's directory.
  assert.equal(JSON.parse(viaLink.stdout).bundle, real);
  const spoofed = spawnSync(join(APP, LAUNCHER), ["selftest"], {
    encoding: "utf8",
    argv0: join(other, LAUNCHER),
  });
  assert.equal(spoofed.status, 0, spoofed.stderr);
  assert.equal(JSON.parse(spoofed.stdout).bundle, real, "argv[0] chose the bundle");
  assert.notEqual(realpathSync(other), real);
});

test("no module planted in a node_modules above the bundle, or in the home folder, loads", {
  skip,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "sf-launcher-planted-"));
  const deep = join(root, "a", "b");
  const marker = join(root, "planted-ran");
  const plant = (dir, name, folder = "node_modules") => {
    const pkg = join(dir, folder, name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, main: "index.js" }));
    writeFileSync(
      join(pkg, "index.js"),
      `require("fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});\n`,
    );
  };
  for (const dir of [root, join(root, "a"), deep])
    for (const name of [
      "@anthropic-ai/sandbox-runtime",
      "zod",
      "fs",
      "child_process",
      "@software-factory/runner-local",
    ])
      plant(dir, name);
  // Node's global folders under the home folder: only on CI, whose home is thrown away.
  const home = homedir();
  const homeFolders = [".node_modules", ".node_libraries"].filter(
    (f) => process.env.CI === "true" && !existsSync(join(home, f)),
  );
  for (const folder of homeFolders)
    for (const name of ["@anthropic-ai/sandbox-runtime", "zod", "fs"]) plant(home, name, folder);
  const app = copy(deep);
  try {
    // Each script must actually run (a copy that refused every start would plant nothing too):
    // the guard (not built yet: 64, with its own message), the self-test, the runner's CLI (an
    // unknown subcommand after loading everything: its usage, 2) and the check child (no input:
    // it fails, 1, after loading the sandbox runtime).
    const want = [
      { args: [], status: 64, ran: (r) => /the guard isn't built yet/.test(r.stderr) },
      { args: ["selftest"], status: 0, ran: (r) => JSON.parse(r.stdout).ok === true },
      {
        args: ["service-status", "--json"],
        status: 2,
        ran: (r) => /usage: sf-runner/.test(r.stdout),
      },
      { args: ["check-child"], status: 1, ran: () => true },
    ];
    for (const { args, status, ran } of want) {
      const r = launch(app, args, { input: "" });
      assert.equal(r.status, status, `${args}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /launcher: (refused|usage)/, `${args}`);
      assert.ok(ran(r), `${args} didn't run its script: ${r.stdout} ${r.stderr}`);
    }
  } finally {
    for (const folder of homeFolders) rmSync(join(home, folder), { recursive: true, force: true });
  }
  let ran = "";
  try {
    ran = readFileSync(marker, "utf8");
  } catch {}
  assert.equal(ran, "", `planted modules ran: ${ran}`);
  if (homeFolders.length === 0 && process.env.CI === "true")
    console.log("~/.node_modules and ~/.node_libraries already exist: not planted there");
});

test("a stop sent while the launcher is still checking reaches Node", { skip }, async () => {
  // The check child waits on stdin, so only the signal ends it. Sent while the launcher checks the
  // bundle (tens of ms), the signal stays pending (blocked) and is forwarded once Node runs: the
  // launcher exits 143. Neither dropped (a hang) nor ending the launcher itself (killed by the
  // signal, Node never told). A signal can still beat the launcher's first instruction, which ends
  // it by the signal: that attempt is retried, and every attempt ending that way fails the test.
  const outcomes = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const launcher = spawn(join(APP, LAUNCHER), ["check-child"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    launcher.stderr.on("data", (d) => {
      stderr += d;
    });
    const exited = new Promise((r) => launcher.on("exit", (code, signal) => r({ code, signal })));
    await new Promise((r) => setTimeout(r, 15));
    launcher.kill("SIGTERM");
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 15_000));
    const result = await Promise.race([exited, timeout]);
    launcher.stdin.destroy();
    if (result === "timeout") {
      launcher.kill("SIGKILL");
      assert.fail(`the SIGTERM was dropped: still running after 15 s (${stderr})`);
    }
    if (result.code !== null) {
      assert.equal(result.code, 143, stderr);
      return;
    }
    outcomes.push(result.signal);
  }
  assert.fail(`the launcher was ended by the signal itself every time: ${outcomes.join(", ")}`);
});

test("SIGUSR1 to the Node child opens no inspector", { skip }, async () => {
  // The check child waits for its input on stdin, so it stays up long enough to signal.
  const launcher = spawn(join(APP, LAUNCHER), ["check-child"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((r) => launcher.on("exit", r));
  await new Promise((r) => setTimeout(r, 1500));
  const node = execFileSync("pgrep", ["-P", String(launcher.pid), "-f", "Helpers/node"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  assert.ok(node, "the launcher's Node child");
  try {
    process.kill(Number(node), "SIGUSR1");
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
  // Its own listening sockets, not the port: another process on the machine may hold 9229.
  const listening = spawnSync("lsof", ["-nP", "-a", "-p", node, "-iTCP", "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  launcher.stdin.end();
  launcher.kill("SIGTERM");
  await exited;
  assert.equal(listening.stdout.trim(), "", "the Node child listens for an inspector");
});

test("Helpers/node refuses to start from anything but the launcher (launch constraint)", {
  skip,
}, () => {
  const r = spawnSync(join(APP, "Contents/Helpers/node"), ["-e", "console.log('ran')"], {
    encoding: "utf8",
  });
  const held = r.signal === "SIGKILL" && r.stdout === "";
  record(
    `launch constraint on Helpers/node, ${teamSigned ? "team-signed" : "ad hoc"}, macOS ${macosMajor}: ${held ? "held (SIGKILL)" : "NOT enforced"}`,
  );
  // Observed: enforced ad hoc on macOS 26, not on macOS 15. A release (team-signed) must hold it.
  if (teamSigned || macosMajor >= 26) assert.ok(held, "Node ran outside the launcher");
});

test("the check's cost per start is recorded", { skip }, () => {
  const times = [];
  for (let i = 0; i < 10; i++) {
    const r = selftest(APP, { env: { ...process.env, SF_RUNNER_LAUNCHER_TIMING: "1" } });
    const m = /checked the bundle in ([\d.]+) ms/.exec(r.stderr);
    assert.ok(m, r.stderr);
    times.push(Number(m[1]));
  }
  times.sort((a, b) => a - b);
  record(
    `launcher check: median ${times[5]} ms, max ${times[9]} ms over 10 starts (macOS ${macosMajor})`,
  );
  assert.ok(times[5] < 1000, "over the 1 s budget");
});
