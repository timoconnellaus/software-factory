// Publishes a signed release to R2 (spec 40 M4), from CI's `release` environment only.
//
//   node scripts/publish-release.ts check  --channel canary --version 0.1.42
//   node scripts/publish-release.ts upload --channel canary --version 0.1.42
//
// - `check` (before building) refuses a version that isn't higher than the one the channel's
//   manifest names, and a version whose archive is already in the bucket: nothing is overwritten
//   and nothing goes backwards.
// - `upload` gives the archive and the download versioned names, rewrites the manifests to name the
//   versioned archive, and uploads the manifests last. A client reading a manifest always finds the
//   archive it names, with the hash it names; a versioned name is never reused, so `immutable` holds.
//   After the manifests, `<channel>-macos-arm64-protocol.json` names the door protocol the now-live
//   build speaks (ADR 0393): the engine's deploy refuses a DESKTOP_MIN_PROTOCOL above it
//   (scripts/deploy/desktop-floor.ts). Written last, it never claims a protocol before the build
//   that speaks it is live.
//
// It talks to R2's S3 API with the AWS CLI and an R2 token scoped to the one bucket
// (DESKTOP_R2_ACCESS_KEY_ID / DESKTOP_R2_SECRET_ACCESS_KEY, held only by the `release` environment).
// The repo-wide CLOUDFLARE_API_TOKEN is not used: it can't publish a build.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOOR_PROTOCOL } from "../src/bun/protocol.ts";
import { compareVersions } from "../src/shared/version.ts";

const PREFIX = "desktop/";
const PLATFORM = "macos-arm64";
const IMMUTABLE = "public, max-age=31536000, immutable";

export interface Upload {
  /** Local file to upload. */
  from: string;
  /** Object key in the bucket. */
  key: string;
  contentType: string;
  cacheControl: string;
}

interface Manifest {
  channel: string;
  version: string;
  artifact: { file: string };
}

/** The archive's versioned name: `canary-macos-arm64-SoftwareFactory-canary-0.1.42.app.tar.zst`. */
export const versionedArchive = (file: string, version: string) =>
  file.replace(/\.app\.tar\.zst$/, `-${version}.app.tar.zst`);

/** The published build's door protocol (ADR 0393), read by the engine's deploy. */
export const protocolFile = (channel: string) => `${channel}-${PLATFORM}-protocol.json`;

/** The download's versioned name: `canary-macos-arm64-Software-Factory-0.1.42.zip`. */
export const versionedDownload = (channel: string, version: string) =>
  `${channel}-${PLATFORM}-Software-Factory-${version}.zip`;

/**
 * What to upload and in what order: archives and downloads under versioned names first, the
 * unversioned download next, the manifests (rewritten to name the versioned archive) last.
 * `write` saves a rewritten manifest and returns its path.
 */
export function uploadPlan(
  files: string[],
  read: (name: string) => string,
  write: (name: string, body: string) => string,
  channel: string,
  version: string,
  protocol: number = DOOR_PROTOCOL,
): Upload[] {
  const head = `${channel}-${PLATFORM}-`;
  const mine = files.filter((f) => f.startsWith(head));
  const archives = mine.filter((f) => f.endsWith(".app.tar.zst"));
  if (archives.length !== 1)
    throw new Error(`expected one ${head}*.app.tar.zst, found ${archives.length}`);
  const archive = archives[0] as string;
  const manifests = mine.filter((f) => /-update(-v2)?\.json$/.test(f));
  if (!manifests.some((m) => m.endsWith("-update-v2.json")))
    throw new Error(`no ${head}update-v2.json`);
  const zip = `${head}Software-Factory.zip`;
  const plan: Upload[] = [];
  const key = (name: string) => `${PREFIX}${name}`;

  plan.push({
    from: archive,
    key: key(versionedArchive(archive, version)),
    contentType: "application/octet-stream",
    cacheControl: IMMUTABLE,
  });
  // Anything else Electrobun made (delta patches, named by hash) goes before the manifests too.
  for (const f of mine) {
    if (f === archive || f === zip || manifests.includes(f)) continue;
    plan.push({
      from: f,
      key: key(f),
      contentType: "application/octet-stream",
      cacheControl: "no-cache",
    });
  }
  if (mine.includes(zip)) {
    plan.push({
      from: zip,
      key: key(versionedDownload(channel, version)),
      contentType: "application/zip",
      cacheControl: IMMUTABLE,
    });
    plan.push({
      from: zip,
      key: key(zip),
      contentType: "application/zip",
      cacheControl: "no-cache",
    });
  }
  // The legacy manifest before v2: current clients read v2, so v2 is the very last write.
  for (const m of [...manifests].sort(
    (a, b) => Number(a.endsWith("-v2.json")) - Number(b.endsWith("-v2.json")),
  )) {
    const doc = JSON.parse(read(m)) as Manifest;
    if (doc.channel !== channel || doc.version !== version)
      throw new Error(`${m} is ${doc.channel} ${doc.version}, not ${channel} ${version}`);
    if (doc.artifact?.file !== archive)
      throw new Error(`${m} names ${doc.artifact?.file}, not ${archive}`);
    doc.artifact.file = versionedArchive(archive, version);
    plan.push({
      from: write(m, JSON.stringify(doc)),
      key: key(m),
      contentType: "application/json",
      cacheControl: "no-cache",
    });
  }
  // The very last write: the build that speaks this protocol is live now.
  const pf = protocolFile(channel);
  plan.push({
    from: write(pf, JSON.stringify({ channel, version, protocol })),
    key: key(pf),
    contentType: "application/json",
    cacheControl: "no-cache",
  });
  return plan;
}

/** Why publishing `version` would be refused, or null. `published` is the live manifest's version. */
export function refusal(
  channel: string,
  version: string,
  published: string | null,
  archiveExists: boolean,
): string | null {
  if (!["canary", "stable"].includes(channel)) return `unknown channel ${channel}`;
  if (compareVersions(version, version) === null) return `${version} is not a version`;
  if (archiveExists)
    return `${channel} ${version} is already published; versions are never overwritten`;
  if (published !== null && compareVersions(version, published) !== 1)
    return `${channel} ${version} is not higher than the published ${published}`;
  return null;
}

// --- the CLI (CI only) ---

function aws(args: string[], opts: { allowFail?: boolean } = {}) {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !bucket) throw new Error("R2_ENDPOINT and R2_BUCKET must be set");
  const r = spawnSync("aws", [...args, "--endpoint-url", endpoint], {
    encoding: "utf8",
    env: { ...process.env, AWS_DEFAULT_REGION: "auto", AWS_REGION: "auto" },
  });
  if (r.status !== 0 && !opts.allowFail)
    throw new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`);
  return r;
}

/**
 * What a `head-object` answer means: there (exit 0), not there (a real 404, and only that), or a
 * throw. Anything else (no credentials, a 403, a network error) fails closed: treating it as "not
 * there" would let a duplicate or lower version through, and `check` would say "ok to publish".
 */
export function headResult(status: number | null, stderr: string, key: string): boolean {
  if (status === 0) return true;
  if (/\(404\)|\bNot Found\b|NoSuchKey/.test(stderr)) return false;
  throw new Error(
    `can't tell whether ${key} is published (aws exit ${status}): ${stderr.trim().slice(0, 300)}`,
  );
}

function exists(key: string): boolean {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (the bucket's R2 token) must be set",
    );
  const r = aws(
    ["s3api", "head-object", "--bucket", process.env.R2_BUCKET as string, "--key", key],
    {
      allowFail: true,
    },
  );
  return headResult(r.status, r.stderr ?? "", key);
}

function publishedVersion(channel: string, dir: string): string | null {
  const key = `${PREFIX}${channel}-${PLATFORM}-update-v2.json`;
  if (!exists(key)) return null;
  const out = join(dir, "published.json");
  aws(["s3api", "get-object", "--bucket", process.env.R2_BUCKET as string, "--key", key, out]);
  return (JSON.parse(readFileSync(out, "utf8")) as Manifest).version;
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const arg = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    const v = i >= 0 ? rest[i + 1] : undefined;
    if (!v) throw new Error(`--${name} is required`);
    return v;
  };
  const channel = arg("channel");
  const version = arg("version");
  const tmp = mkdtempSync(join(tmpdir(), "sf-publish-"));
  try {
    if (cmd === "check" || cmd === "upload") {
      const why = refusal(
        channel,
        version,
        publishedVersion(channel, tmp),
        exists(`${PREFIX}${versionedDownload(channel, version)}`),
      );
      if (why) throw new Error(why);
    }
    if (cmd === "check") return console.log(`${channel} ${version}: ok to publish`);
    if (cmd !== "upload") throw new Error(`unknown command ${cmd}`);
    const dir = "artifacts";
    const plan = uploadPlan(
      readdirSync(dir),
      (n) => readFileSync(join(dir, n), "utf8"),
      (n, body) => {
        const p = join(tmp, n);
        writeFileSync(p, body);
        return p;
      },
      channel,
      version,
    );
    // A versioned name is written once: a run that stopped halfway is published again as a new version.
    for (const u of plan) {
      if (u.cacheControl === IMMUTABLE && exists(u.key))
        throw new Error(`${u.key} is already published; versions are never overwritten`);
    }
    for (const u of plan) {
      const from = u.from.startsWith(tmp) ? u.from : join(dir, u.from);
      aws([
        "s3api",
        "put-object",
        "--bucket",
        process.env.R2_BUCKET as string,
        "--key",
        u.key,
        "--body",
        from,
        "--content-type",
        u.contentType,
        "--cache-control",
        u.cacheControl,
      ]);
      console.log(`uploaded ${u.key}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`publish-release: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
