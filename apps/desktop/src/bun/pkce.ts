// PKCE S256 and the sign-in state (ADR 0391).
export function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const randomUrlSafe = (bytes = 32) =>
  base64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomUrlSafe(32);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(hash)) };
}
