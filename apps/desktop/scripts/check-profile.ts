// The key helper's entitlements against its embedded provisioning profile (spec 40 M4b, "The
// release"): every entitlement the helper claims must be allowed by the profile, the profile must
// name the certificate that signed the helper, and its expiry is printed (a warning under 60 days).
// macOS kills a helper that fails any of these; the release fails first.
//
//   node scripts/check-profile.ts "<app>/Contents/Helpers/SF Keys.app"
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Ents = Record<string, unknown>;

export const WARN_DAYS = 60;

/** A profile value allows a claimed string when equal, or as a `PREFIX.*` wildcard. */
function allows(allowed: unknown, claimed: unknown): boolean {
  if (typeof allowed === "string" && typeof claimed === "string") {
    if (allowed === claimed) return true;
    return allowed.endsWith("*") && claimed.startsWith(allowed.slice(0, -1));
  }
  if (Array.isArray(allowed)) return allowed.some((a) => allows(a, claimed));
  if (typeof allowed === "boolean") return allowed === true && claimed === true;
  return false;
}

/** What the profile doesn't allow of the helper's entitlements (empty when it allows them all). */
export function entitlementProblems(claimed: Ents, profile: Ents): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(claimed)) {
    if (!(key in profile)) {
      problems.push(`${key} is not in the profile`);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) problems.push(`${key} is empty`);
    for (const v of values)
      if (!allows(profile[key], v))
        problems.push(
          `${key} = ${JSON.stringify(v)} is not allowed by ${JSON.stringify(profile[key])}`,
        );
  }
  return problems;
}

/** The expiry line, and whether it is a warning. A past expiry is an error. */
export function expiry(
  expires: Date,
  now: Date,
): { level: "ok" | "warning" | "error"; text: string } {
  const days = Math.floor((expires.getTime() - now.getTime()) / 86_400_000);
  const when = expires.toISOString().slice(0, 10);
  if (days < 0) return { level: "error", text: `the key helper's profile expired on ${when}` };
  if (days < WARN_DAYS)
    return {
      level: "warning",
      text: `the key helper's profile expires on ${when} (${days} days): renew it (spec 40 M4b, owner step 6)`,
    };
  return { level: "ok", text: `the key helper's profile expires on ${when} (${days} days)` };
}

function run(cmd: string, args: string[], input?: string): string {
  const r = spawnSync(cmd, args, { input, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr?.toString().trim()}`);
  return r.stdout.toString();
}

const sha1 = (der: Buffer) => createHash("sha1").update(der).digest("hex");

function main(helper: string): void {
  const profileXml = run("security", [
    "cms",
    "-D",
    "-i",
    join(helper, "Contents/embedded.provisionprofile"),
  ]);
  const extract = (path: string, as: "json" | "raw") =>
    run("plutil", ["-extract", path, as, "-o", "-", "-"], profileXml).trim();
  const profileEnts = JSON.parse(extract("Entitlements", "json")) as Ents;
  const claimedXml = run("codesign", ["-d", "--entitlements", "-", "--xml", helper]);
  const claimed = JSON.parse(
    run("plutil", ["-convert", "json", "-o", "-", "-"], claimedXml),
  ) as Ents;

  const problems = entitlementProblems(claimed, profileEnts);

  // The profile's certificate is the one that signed the helper.
  const work = mkdtempSync(join(tmpdir(), "sf-keys-cert-"));
  try {
    run("codesign", ["-d", `--extract-certificates=${join(work, "cert")}`, helper]);
    const signer = sha1(readFileSync(join(work, "cert0")));
    const named = sha1(Buffer.from(extract("DeveloperCertificates.0", "raw"), "base64"));
    if (signer !== named)
      problems.push(`the profile names certificate ${named}, the helper is signed by ${signer}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const e = expiry(new Date(extract("ExpirationDate", "raw")), new Date());
  if (e.level === "error") problems.push(e.text);
  else
    console.log(e.level === "warning" ? `::warning title=Key helper profile::${e.text}` : e.text);

  if (problems.length) {
    for (const p of problems) console.log(`::error::check-profile: ${p}`);
    process.exit(1);
  }
  console.log(`check-profile: the profile allows all ${Object.keys(claimed).length} entitlements`);
}

if (!process.env.VITEST) {
  const helper = process.argv[2];
  if (!helper) throw new Error("usage: node scripts/check-profile.ts <SF Keys.app>");
  main(helper);
}
