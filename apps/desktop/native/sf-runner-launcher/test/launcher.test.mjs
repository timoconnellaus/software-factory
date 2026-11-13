// SF Runner.app's launcher against a real bundle (spec 45 criteria 1, 2 and 2a, the bundle half).
// macOS only. CI runs it on an ad-hoc build (the launcher compiled with no Team ID), and the
// release on the Developer ID-signed, notarized bundle:
//
//   node apps/desktop/scripts/vendor-node.mjs && node apps/desktop/scripts/bundle-runner.mjs --sealed
//   node apps/desktop/scripts/runner-app.mjs --out "$dir"
//   SF_RUNNER_APP="$dir/SF Runner.app" node --test apps/desktop/native/sf-runner-launcher/test/
//
// Each tamper case works on its own copy of the bundle. Nothing here touches the home folder: the
// launcher reads `service-env.json` and writes `launch-refused.json` under the account's home, so
// the tests only read what they need from its output and exit codes.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const APP = process.env.SF_RUNNER_APP;
const skip = process.platform !== "darwin" || !APP ? "macOS, with SF_RUNNER_APP set" : false;
const LAUNCHER = "Contents/MacOS/sf-runner";

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

test("an untouched bundle runs its self-test with exactly the environment and flags of §1", {
  skip,
}, () => {
  const r = selftest(APP, {
    env: {
      ...process.env,
      NODE_OPTIONS: "--require /tmp/sf-planted.js",
      NODE_PATH: "/tmp",
      DYLD_INSERT_LIBRARIES: "/tmp/sf-planted.dylib",
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

test("a path, an unknown entry or extra arguments exit 64 before Node", { skip }, () => {
  for (const args of [
    ["/tmp/x.js"],
    ["./sf-runner.cjs"],
    ["nope"],
    ["runner", "runner"],
    ["selftest", "--inspect"],
    ["run"],
  ]) {
    const r = launch(APP, args);
    assert.equal(r.status, 64, `${args}`);
    assert.equal(r.stdout, "");
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
  const real = execFileSync("realpath", [APP], { encoding: "utf8" }).trim();
  assert.equal(JSON.parse(viaLink.stdout).envKeys.includes("SF_RUNNER_BUNDLE"), true);
  const spoofed = spawnSync(join(APP, LAUNCHER), ["selftest"], {
    encoding: "utf8",
    argv0: join(other, LAUNCHER),
  });
  assert.equal(spoofed.status, 0, spoofed.stderr);
  // The bundle's own version.json was read, through SF_RUNNER_BUNDLE = its resolved path.
  assert.ok(real.endsWith("SF Runner.app"));
});

test("no module planted in a node_modules above the bundle loads", { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), "sf-launcher-planted-"));
  const deep = join(root, "a", "b");
  const marker = join(root, "planted-ran");
  const plant = (dir, name) => {
    const pkg = join(dir, "node_modules", name);
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
  const app = copy(deep);
  // The guard, the self-test, the runner's CLI (an unknown subcommand after loading everything)
  // and the check child (no input: it fails after loading the sandbox runtime).
  for (const args of [[], ["selftest"], ["service-status", "--json"], ["check-child"]])
    launch(app, args, { input: "" });
  let ran = "";
  try {
    ran = readFileSync(marker, "utf8");
  } catch {}
  assert.equal(ran, "", `planted modules ran: ${ran}`);
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
  assert.notEqual(r.stdout, "ran\n", "Node ran outside the launcher");
  assert.equal(r.signal, "SIGKILL");
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
  const line = `launcher check: median ${times[5]} ms, max ${times[9]} ms over 10 starts`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  assert.ok(times[5] < 1000, "over the 1 s budget");
});
