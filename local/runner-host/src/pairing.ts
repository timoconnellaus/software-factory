// Small, pure pieces of `sf-runner pair` and `sf-runner install`, kept apart from the CLI so they can
// be tested (incident 2026-11-11-bootstrap, docs/incidents/).
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** The Node major the runner host needs (`.nvmrc`; `--experimental-transform-types`). */
export const MIN_NODE_MAJOR = 24;

/**
 * Reads the key from what was piped to `pair --key-stdin`. Accepts the bare key, or the app's
 * two-line block (`runner id: r_…` / `key: …`). When both the block and `--runner-id` name a
 * runner, they must agree: a key only signs for the runner it was issued to, and a mismatch would
 * otherwise surface as `401 bad signature`.
 */
export function parsePairingInput(
  text: string,
  runnerIdArg: string | undefined,
): { key: string; runnerId: string | undefined } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let key: string | undefined;
  let runnerId: string | undefined;
  for (const line of lines) {
    const m = /^(runner[ _-]?id|key)\s*[:=]\s*(.+)$/i.exec(line);
    if (!m) continue;
    const value = (m[2] ?? "").trim();
    if (m[1]?.toLowerCase() === "key") key = value;
    else runnerId = value;
  }
  if (key === undefined) {
    if (lines.length !== 1) {
      throw new Error(
        "Couldn't read a key from stdin: pipe either the bare key or the app's two lines (`runner id: r_…` and `key: …`).",
      );
    }
    key = lines[0] as string;
  }
  if (/\s/.test(key)) throw new Error("The key on stdin has spaces in it: copy it again.");
  if (runnerId && runnerIdArg && runnerId !== runnerIdArg) {
    throw new Error(
      `Runner id mismatch: --runner-id is ${runnerIdArg} but the pasted key is for ${runnerId}. A key only works for the runner it was issued to.`,
    );
  }
  return { key, runnerId: runnerIdArg ?? runnerId };
}

/**
 * The Node the launchd service runs, and the PATH it gets. Refuses a Node older than
 * {@link MIN_NODE_MAJOR}: the service would otherwise pin whatever `node` the installing shell had.
 * The chosen Node's directory goes first on PATH, so tools the runner spawns use the same Node.
 */
export function serviceNode(input: {
  execPath: string;
  version: string;
  path: string | undefined;
}): { node: string; path: string } {
  const major = Number(input.version.replace(/^v/, "").split(".")[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      [
        `sf-runner install needs Node ≥ ${MIN_NODE_MAJOR}, but it is running on ${input.version} (${input.execPath}).`,
        "The launchd service would be pinned to this Node. Fix it with one of:",
        `  nvm use ${MIN_NODE_MAJOR} && local/runner-host/bin/sf-runner install`,
        `  SF_RUNNER_NODE=$HOME/.nvm/versions/node/<v${MIN_NODE_MAJOR}.x>/bin/node local/runner-host/bin/sf-runner install`,
      ].join("\n"),
    );
  }
  if (!isAbsolute(input.execPath)) {
    throw new Error(`Can't pin the service to Node at ${input.execPath}: not an absolute path.`);
  }
  const bin = dirname(input.execPath);
  const rest = (input.path ?? "/usr/bin:/bin").split(delimiter).filter((p) => p && p !== bin);
  return { node: input.execPath, path: [bin, ...rest].join(delimiter) };
}

/** Where Orca.app keeps its CLI. */
export const ORCA_APP_BIN = "/Applications/Orca.app/Contents/Resources/bin";

/**
 * The service PATH with Orca's bin directory on it (incident 2026-11-11 #9: an install over SSH
 * captured a PATH without Orca, so the service couldn't start jobs). Unchanged when a directory on
 * it already has `orca`; otherwise `orcaBin`'s directory from the config, else Orca.app's, is added
 * at the end. Null `added` when none was found.
 */
export function withOrcaOnPath(input: {
  path: string;
  orcaBin?: string | undefined;
  isFile: (file: string) => boolean;
}): { path: string; added: string | null } {
  const dirs = input.path.split(delimiter).filter(Boolean);
  if (dirs.some((d) => input.isFile(join(d, "orca")))) return { path: input.path, added: null };
  const fromConfig =
    input.orcaBin && isAbsolute(input.orcaBin) && input.isFile(input.orcaBin)
      ? dirname(input.orcaBin)
      : null;
  const found = fromConfig ?? (input.isFile(join(ORCA_APP_BIN, "orca")) ? ORCA_APP_BIN : null);
  if (!found) return { path: input.path, added: null };
  return { path: [...dirs, found].join(delimiter), added: found };
}
