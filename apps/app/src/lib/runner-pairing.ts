// What Setup's runner-key Copy buttons put on the clipboard (incident 2026-11-11-bootstrap: the old
// Copy gave `runner id: …\nkey: …`, which `sf-runner pair --key-stdin` took as the key).

/**
 * The command to run on the runner's Mac. It reads the key from the clipboard (`pbpaste`), so the
 * key never lands in shell history: paste the command, copy the key, then press Enter.
 */
export function pairCommand(runnerId: string): string {
  return `pbpaste | local/runner-host/bin/sf-runner pair --runner-id ${runnerId} --key-stdin`;
}

/**
 * Connecting a runner (ADR 0056): run this on the runner's machine, from the software-factory
 * checkout. It prints a code and a link to /runners/connect, waits for approval, saves its key and
 * installs the service.
 */
export const LOGIN_COMMAND = "local/runner-host/bin/sf-runner login";
