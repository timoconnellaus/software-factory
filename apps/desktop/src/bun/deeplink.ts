// sf:// links (ADR 0391, 0372): the sign-in callback, and app routes from the /open/* trampoline.
export type DeepLink =
  | { kind: "auth"; code: string; state: string }
  | { kind: "route"; path: string }
  | { kind: "unknown"; url: string };

const ROUTE = /^\/(work\/[A-Za-z0-9_-]{1,80}(\/review)?|attach|inbox|setup)$/;

export function parseDeepLink(url: string): DeepLink {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: "unknown", url };
  }
  if (u.protocol !== "sf:") return { kind: "unknown", url };
  // sf://work/123 parses as host "work", path "/123".
  const path = `/${u.host}${u.pathname}`.replace(/\/+$/, "");
  if (path === "/auth/callback") {
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    return code && state ? { kind: "auth", code, state } : { kind: "unknown", url };
  }
  if (ROUTE.test(path)) return { kind: "route", path: `${path}${u.search}` };
  return { kind: "unknown", url };
}
