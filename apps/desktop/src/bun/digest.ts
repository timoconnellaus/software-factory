// What a presence proof is bound to (ADR 0391): the SHA-256 of the input's canonical JSON. The same
// rule as core's `inputDigest`; test/door.test.ts checks they agree.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export async function inputDigest(input: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(input ?? {})),
  );
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the device key signs (ADR 0391); the last line is the summary the Touch ID prompt shows. */
export const presenceMessage = (nonce: string, op: string, digest: string, summary: string) =>
  `${nonce}\n${op}\n${digest}\n${summary}`;
