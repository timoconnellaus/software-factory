// The Live tab's Web terminal view (spec 35, ADR 0440): the shared xterm.js view (packages/client,
// spec 42) on a WebSocket to this app's own route for the run.
import { WebTerminal as SharedTerminal } from "@software-factory/client/web-terminal-view";
import { terminalUrl } from "#/lib/web-terminal";

export function WebTerminal({ workItemId, runId }: { workItemId: string; runId: string }) {
  return (
    <SharedTerminal
      connect={() => new WebSocket(terminalUrl(window.location, workItemId, runId))}
    />
  );
}
