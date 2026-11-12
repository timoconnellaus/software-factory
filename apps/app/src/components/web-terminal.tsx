// The Live tab's Web terminal view (spec 35, ADR 0440): the shared xterm.js view (packages/client,
// spec 42) on a WebSocket to this app's own route for the run. Keyed and named by the run: the Live
// tab's poll can swap an ended run for a new one, and the view must attach to the new one.
import { WebTerminal as SharedTerminal } from "@software-factory/client/web-terminal-view";
import { terminalUrl } from "#/lib/web-terminal";

export function WebTerminal({ workItemId, runId }: { workItemId: string; runId: string }) {
  return (
    <SharedTerminal
      key={`${workItemId}/${runId}`}
      session={`${workItemId}/${runId}`}
      connect={() => new WebSocket(terminalUrl(window.location, workItemId, runId))}
      openLink={(url) => void window.open(url, "_blank", "noopener,noreferrer")}
    />
  );
}
