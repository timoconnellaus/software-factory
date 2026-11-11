// Every account signed in on this device, and a way to act as exactly one of them.
//
// The multi-session plugin keeps one signed cookie per account:
//   <session cookie>_multi-<token lowercased> = <token>.<signature>
// plus the usual <session cookie> for the *active* account. An "account session" here is a
// Headers object carrying only one account's signed token as the session cookie, so whatever
// Better Auth call we make with it runs as that account and nothing else, whichever is active.
import type { Auth } from "./auth.ts";

export interface DeviceAccount {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  /** True for the account the session cookie currently points at. */
  active: boolean;
  /** Headers that act as this account only. Server-side; never sent to the browser. */
  headers: Headers;
  /** Raw session token. Server-side only (needed for set-active / revoke). */
  sessionToken: string;
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name && !out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

/** Lists the accounts this request's browser is signed in to (valid, unexpired sessions only). */
export async function listDeviceAccounts(auth: Auth, request: Request): Promise<DeviceAccount[]> {
  const ctx = await auth.$context;
  const cookieName = ctx.authCookies.sessionToken.name;
  const cookies = parseCookieHeader(request.headers.get("cookie"));

  // Better Auth verifies each _multi- cookie's signature and the session row (and expiry).
  const devices = await auth.api.listDeviceSessions({ headers: request.headers });
  const active = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  });

  const accounts: DeviceAccount[] = [];
  for (const { session, user } of devices) {
    const signed = cookies.get(`${cookieName}_multi-${session.token.toLowerCase()}`);
    if (!signed) continue;
    accounts.push({
      userId: user.id,
      email: user.email,
      name: user.name,
      image: user.image ?? null,
      active: active?.session.token === session.token,
      headers: new Headers({ cookie: `${cookieName}=${signed}` }),
      sessionToken: session.token,
    });
  }
  return accounts;
}

export class AccountNotSignedInError extends Error {
  override name = "AccountNotSignedInError";
}

/**
 * The account session for `userId` on this device. Throws when that account isn't signed in
 * here: an action never falls back to the active session or to another account.
 */
export async function accountSession(
  auth: Auth,
  request: Request,
  userId: string,
): Promise<DeviceAccount> {
  const account = (await listDeviceAccounts(auth, request)).find((a) => a.userId === userId);
  if (!account) throw new AccountNotSignedInError(`Account ${userId} is not signed in here`);
  return account;
}
