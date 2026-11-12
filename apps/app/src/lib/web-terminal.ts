// The Live tab's web terminal (spec 35, ADR 0440): the socket's URL here; the client that reads the
// relay's frames is shared with the desktop app from `packages/client` (spec 42).
export * from "@software-factory/client/web-terminal";

/** The page's socket for a run's terminal (same origin, so the session cookie goes with it). */
export function terminalUrl(
  location: { protocol: string; host: string },
  workItemId: string,
  runId: string,
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/work/${workItemId}/runs/${runId}/terminal`;
}
