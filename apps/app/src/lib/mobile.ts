// The phone app's identity on the website (ADR 0541): its package, and the Digital Asset Links
// statement that lets Android open `/mobile/callback` and `/mobile/pair` in the app (App Links).
export const MOBILE_PACKAGE = "com.zerobsai.factory";
export const ASSET_LINKS_PATH = "/.well-known/assetlinks.json";

/** `ab:cd…` or `abcd…` → `AB:CD:…`, as Android's assetlinks.json wants it. */
export function certFingerprint(text: string): string | null {
  const hex = text.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 64) return null;
  return hex.match(/../g)?.join(":") ?? null;
}

/** The statement for MOBILE_SIGNING_CERTS (comma-separated SHA-256s); empty when none is set. */
export function assetLinks(signingCerts: string | undefined) {
  const fingerprints = (signingCerts ?? "")
    .split(",")
    .map(certFingerprint)
    .filter((f): f is string => f !== null);
  if (fingerprints.length === 0) return [];
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: MOBILE_PACKAGE,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

/** Where a device's key lives, in words. */
export function keyStorageLabel(keyStorage: string): string {
  switch (keyStorage) {
    case "secure-enclave":
      return "in the Secure Enclave";
    case "strongbox":
      return "in StrongBox";
    case "tee":
      return "in the phone's secure hardware (TEE)";
    default:
      return "a software key: can't approve";
  }
}
