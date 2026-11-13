// The key helper's entitlements against its embedded provisioning profile (spec 40 M4b, "The
// release"): every entitlement the helper claims must be allowed by the profile, the profile must
// name the certificate that signed the helper, and its expiry is printed (a warning under 60 days).
// macOS kills a helper that fails any of these; the release fails first.
//
//   node scripts/check-profile.ts "<app>/Contents/Helpers/SF Keys.app"
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    // plutil writes its errors to stdout, codesign and security to stderr: show both.
    const why = [r.stdout, r.stderr]
      .map((b) => b?.toString().trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${why || "(no output)"}`);
  }
  return r.stdout.toString();
}

const sha1 = (der: Buffer) => createHash("sha1").update(der).digest("hex");

/**
 * What the check needs from a decoded profile (its plist XML): the Entitlements, the first
 * certificate's DER and the expiry. Each value is taken out with `plutil -extract … xml1` from a
 * file (not stdin, and not as json or raw, whose handling of a profile's <data> and <date> differs
 * between macOS versions), then read from that small XML.
 */
export function readProfile(profileXml: string): {
  entitlements: Ents;
  certificate: Buffer;
  expires: Date;
} {
  const work = mkdtempSync(join(tmpdir(), "sf-keys-profile-"));
  try {
    const profile = join(work, "profile.plist");
    writeFileSync(profile, profileXml);
    const extract = (path: string) => {
      const out = join(work, `${path.replace(/\W/g, "_")}.plist`);
      run("plutil", ["-extract", path, "xml1", "-o", out, profile]);
      return out;
    };
    const entsFile = extract("Entitlements");
    run("plutil", ["-convert", "json", entsFile]);
    const entitlements = JSON.parse(readFileSync(entsFile, "utf8")) as Ents;
    const cert = /<data>([\s\S]*?)<\/data>/.exec(
      readFileSync(extract("DeveloperCertificates.0"), "utf8"),
    )?.[1];
    if (!cert) throw new Error("the profile has no DeveloperCertificates");
    const date = /<date>([^<]+)<\/date>/.exec(readFileSync(extract("ExpirationDate"), "utf8"))?.[1];
    if (!date) throw new Error("the profile has no ExpirationDate");
    return {
      entitlements,
      certificate: Buffer.from(cert.replace(/\s+/g, ""), "base64"),
      expires: new Date(date),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The entitlements a signed bundle claims, from `codesign --xml` through a file. */
function claimedEntitlements(helper: string): Ents {
  const work = mkdtempSync(join(tmpdir(), "sf-keys-ents-"));
  try {
    const file = join(work, "ents.plist");
    writeFileSync(file, run("codesign", ["-d", "--entitlements", "-", "--xml", helper]));
    run("plutil", ["-convert", "json", file]);
    return JSON.parse(readFileSync(file, "utf8")) as Ents;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(helper: string): void {
  const profile = readProfile(
    run("security", ["cms", "-D", "-i", join(helper, "Contents/embedded.provisionprofile")]),
  );
  const claimed = claimedEntitlements(helper);
  const problems = entitlementProblems(claimed, profile.entitlements);

  // The profile's certificate is the one that signed the helper.
  const work = mkdtempSync(join(tmpdir(), "sf-keys-cert-"));
  try {
    run("codesign", ["-d", `--extract-certificates=${join(work, "cert")}`, helper]);
    const signer = sha1(readFileSync(join(work, "cert0")));
    const named = sha1(profile.certificate);
    if (signer !== named)
      problems.push(`the profile names certificate ${named}, the helper is signed by ${signer}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const e = expiry(profile.expires, new Date());
  if (e.level === "error") problems.push(e.text);
  else
    console.log(e.level === "warning" ? `::warning title=Key helper profile::${e.text}` : e.text);

  if (problems.length) {
    for (const p of problems) console.log(`::error::check-profile: ${p}`);
    process.exit(1);
  }
  console.log(`check-profile: the profile allows all ${Object.keys(claimed).length} entitlements`);
}

/**
 * `--self-test <profile.plist> [signed binary]`: read a decoded profile (CI's macOS job runs it on a
 * synthetic one shaped like the portal's) and, given one, a binary signed with the helper's
 * entitlements, and check the one against the other, so a plutil or codesign change on the runner
 * shows here and not in a release.
 */
function selfTest(file: string, signed?: string): void {
  const p = readProfile(readFileSync(file, "utf8"));
  if (signed) {
    const ents = claimedEntitlements(signed);
    const problems = entitlementProblems(ents, p.entitlements);
    if (problems.length) throw new Error(`self-test: ${problems.join("; ")}`);
    console.log(
      `check-profile self-test: ${signed} claims ${Object.keys(ents).length} allowed entitlements`,
    );
  }
  if (!Object.keys(p.entitlements).length) throw new Error("no entitlements read");
  if (!p.certificate.length) throw new Error("no certificate read");
  if (Number.isNaN(p.expires.getTime())) throw new Error("no expiry read");
  console.log(
    `check-profile self-test: ${Object.keys(p.entitlements).length} entitlements, a ${p.certificate.length}-byte certificate, expires ${p.expires.toISOString()}`,
  );
}

if (!process.env.VITEST) {
  const [first, second, third] = process.argv.slice(2);
  if (first === "--self-test" && second) selfTest(second, third);
  else if (first) main(first);
  else throw new Error("usage: node scripts/check-profile.ts <SF Keys.app> | --self-test <plist>");
}
