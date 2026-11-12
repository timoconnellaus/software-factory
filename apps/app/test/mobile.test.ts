// The website's side of the phone app (ADR 0541, spec 60 PR 1a): the Digital Asset Links statement
// for App Links, and the bounce to the app from /mobile/callback and /mobile/pair.
import { describe, expect, it } from "vitest";
import { assetLinks, certFingerprint, MOBILE_PACKAGE } from "#/lib/mobile";
import { APP_OPERATIONS, APP_READ_OPERATIONS } from "#/lib/ops";
import { intentUrl } from "#/routes/mobile.callback";

describe("assetlinks.json", () => {
  it("names the package and the release certificate, in Android's format", () => {
    const sha = "ab".repeat(32);
    expect(assetLinks(`${sha}, 5E:5E:${"5E:".repeat(29)}5E`)).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.zerobsai.factory",
          sha256_cert_fingerprints: [certFingerprint(sha), `5E:5E:${"5E:".repeat(29)}5E`],
        },
      },
    ]);
    expect(certFingerprint(sha)).toMatch(/^AB(:AB){31}$/);
  });

  it("is empty while no certificate is set, and skips malformed ones", () => {
    expect(assetLinks("")).toEqual([]);
    expect(assetLinks(undefined)).toEqual([]);
    expect(assetLinks("not-a-digest")).toEqual([]);
  });
});

describe("the App Link bounce", () => {
  it("hands the same URL to our package, the fragment's values in the query", () => {
    expect(
      intentUrl("https://software-factory.zerobsai.com/mobile/pair?offer=pof_1#secret=s"),
    ).toBe(
      `intent://software-factory.zerobsai.com/mobile/pair?offer=pof_1&secret=s#Intent;scheme=https;package=${MOBILE_PACKAGE};end`,
    );
    expect(intentUrl("https://x.example/mobile/callback?code=c&state=t")).toBe(
      `intent://x.example/mobile/callback?code=c&state=t#Intent;scheme=https;package=${MOBILE_PACKAGE};end`,
    );
  });
});

describe("the website's phone operations", () => {
  it("forwards the pairing pages' operations, and never the phone's own sign-in calls", () => {
    for (const op of ["device.list", "device.revoke", "mobile.pairOffer", "mobile.approveDevice"]) {
      expect(APP_OPERATIONS).toContain(op);
    }
    expect(APP_READ_OPERATIONS).toContain("mobile.pairOfferStatus");
    for (const op of ["mobile.authStart", "mobile.authExchange", "mobile.renew", "device.update"]) {
      expect(APP_OPERATIONS as readonly string[]).not.toContain(op);
    }
  });
});
