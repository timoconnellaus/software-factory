// Which account the window is showing (review of #184): the cache and the routes belong to one
// sign-in, so they are reset whenever it changes, not only when "signed in" flips. The main
// process's `auth.finish` doesn't require being signed out first, so a second sign-in (another
// login, or this Mac approved again as another device) arrives while signed in. Pure, for the tests.
import type { QueryClient } from "@tanstack/react-query";
import type { Session } from "../../shared/rpc.ts";

/** The signed-in account as a key ("in:<login>:<deviceId>"), "out", or null before the first answer. */
export function accountKey(
  session: Pick<Session, "signedIn" | "login" | "deviceId"> | null | undefined,
): string | null {
  if (!session) return null;
  return session.signedIn ? `in:${session.login ?? ""}:${session.deviceId ?? ""}` : "out";
}

/** Empties everything the previous account read. The session and update status are the app's. */
export function clearAccountData(client: QueryClient) {
  client.removeQueries({
    predicate: (q) => q.queryKey[0] !== "session" && q.queryKey[0] !== "update",
  });
}
