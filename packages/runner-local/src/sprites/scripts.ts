// What the runner runs inside a job's sprite (ADR 0480). Each is a fixed `/bin/sh` script, run as
// `sh -c <script> sf <args…>`, that takes every path it touches as an argument and marks itself on
// its second line (`# sf-sprite:<name>`). Nothing the agent wrote is ever a script the host runs:
// what comes back (the result bundle, mirrored files) is data, read by the host's own code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The marker on a script's second line: the fake API in tests knows the scripts by it. */
export const SCRIPT_MARKER = /^# sf-sprite:([a-z-]+)$/m;

const script = (name: string, body: string[]) =>
  ["set -eu", `# sf-sprite:${name}`, ...body, ""].join("\n");

/** Becomes root for the few steps that need it (`sudo -n` on Sprites, where the user is `sprite`). */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template.
const SUDO = ['SUDO="${SF_SUDO-sudo -n}"', 'if [ "$(id -u)" = 0 ]; then SUDO=""; fi'];

const SHA_OF = '(sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d" " -f1';

/**
 * The job's files in: `$1` is the root the tar is relative to (`/`), `$2` the tar's sha256, the
 * rest the directories to make and own first (the job dir, the run dir, the attachments). The tar
 * comes on stdin, is kept whole, and is unpacked only if its hash matches (a truncated upload
 * fails). The files land at the same absolute paths they have on the host, so the harness's
 * projected paths (settings, launch script, status file, transcript) hold in the sprite and on
 * the host.
 */
export const UPLOAD = script("upload", [
  ...SUDO,
  'root="$1"; sha="$2"; shift 2',
  `sha_of() { ${SHA_OF}; }`,
  'for d in "$@"; do $SUDO mkdir -p "$d"; $SUDO chown "$(id -u):$(id -g)" "$d"; done',
  "t=$(mktemp); trap 'rm -f \"$t\"' EXIT",
  'cat > "$t"',
  'got=$(sha_of "$t")',
  'if [ "$got" != "$sha" ]; then echo "the upload arrived as $got, not $sha" >&2; exit 65; fi',
  'tar -x -f "$t" -C "$root" --no-same-owner',
  'echo "uploaded $sha"',
]);

/**
 * A file from stdin into `$1` (0600): the model credential (into memory, `/dev/shm`; the entry
 * script reads and deletes it) and the prompt.
 */
export const WRITE = script("write", [
  "umask 077",
  'd=$(dirname "$1"); if [ ! -d "$d" ]; then mkdir -p "$d"; fi',
  'cat > "$1"',
  'echo "written"',
]);

/**
 * What the sprite's TTY runs (`sprite-entry.sh`): `$1` the credential file, `$2` the harness's
 * launch script, `$3` a name for the keep-awake task, `$4` the most seconds the session may run,
 * then `KEY=value` environment. It loads the credential and deletes it, sets the environment, and
 * starts a watchdog tied to this process (which becomes Claude): while Claude lives it holds a
 * Tasks API hold so the sprite doesn't pause mid-turn; once Claude is gone, or the lifetime is up
 * (it then stops Claude), it releases the hold, so the sprite pauses and stops costing compute.
 */
export const ENTRY = script("entry", [
  'cred="$1"; launch="$2"; task="$3"; life="$4"; shift 4',
  'set -a; . "$cred"; set +a',
  'rm -f "$cred"',
  'for kv in "$@"; do export "$kv"; done',
  "me=$$",
  "start=$(date +%s)",
  "(",
  "  hold() {",
  "    if [ -S /.sprite/api.sock ]; then",
  `      curl -s --max-time 10 --unix-socket /.sprite/api.sock -H 'content-type: application/json' "$@" >/dev/null 2>&1 || true`,
  "    fi",
  "  }",
  '  while kill -0 "$me" 2>/dev/null; do',
  '    if [ $(( $(date +%s) - start )) -ge "$life" ]; then kill -TERM "$me" 2>/dev/null; break; fi',
  `    hold -X PUT "http://sprite/v1/tasks/$task" -d '{"expire":"5m"}'`,
  "    sleep 30",
  "  done",
  '  hold -X DELETE "http://sprite/v1/tasks/$task"',
  ") </dev/null >/dev/null 2>&1 &",
  'exec /bin/sh "$launch"',
]);

/** sha256 of each file argument, one per line (`missing` when it isn't a file). */
export const SHA256 = script("sha256", [
  'for f in "$@"; do',
  '  if [ -f "$f" ]; then (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1',
  "  else echo missing; fi",
  "done",
]);

/**
 * The mirror's pull (`mirror.ts`): `$1` is the most bytes per file, then `<path> <offset>` pairs.
 * For each file in order: a line `<index> <size> <count>` (size -1 when missing), then `count`
 * bytes from `offset`.
 */
export const PULL = script("pull", [
  'max="$1"; shift',
  "i=0",
  'while [ "$#" -ge 2 ]; do',
  '  f="$1"; off="$2"; shift 2',
  '  if [ -f "$f" ]; then size=$(wc -c < "$f" | tr -d " "); else size=-1; fi',
  '  n=0; if [ "$size" -gt "$off" ]; then n=$((size - off)); fi',
  '  if [ "$n" -gt "$max" ]; then n="$max"; fi',
  '  printf "%s %s %s\\n" "$i" "$size" "$n"',
  '  if [ "$n" -gt 0 ]; then tail -c +"$((off + 1))" "$f" | head -c "$n"; fi',
  "  i=$((i + 1))",
  "done",
]);

/**
 * The session's result (`result.ts`): `$1` work tree, `$2` git dir, `$3` a temp dir, `$4` the
 * commit the job's files went in at. It snapshots the whole working tree as a commit on top of
 * HEAD (a temporary index, `git add -A`, so ignored files stay out exactly as the host's
 * `commitLeftovers` would leave them), and prints one JSON line (`head`, `snapshot`, `unmerged`,
 * `mergeHead`) followed by a bundle of everything new since `$4`.
 */
export const RESULT = script("result", [
  'work="$1"; gd="$2"; tmp="$3"; base="$4"',
  'export GIT_DIR="$gd" GIT_WORK_TREE="$work" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0',
  "g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c safe.directory='*' \"$@\"; }",
  'cd "$work"',
  "head=$(g rev-parse --verify HEAD)",
  'unmerged=$(g ls-files -u | wc -l | tr -d " ")',
  'merge=""; if [ -f "$gd/MERGE_HEAD" ]; then merge=$(head -n 1 "$gd/MERGE_HEAD"); fi',
  'idx="$tmp/sf-snapshot-index"; rm -f "$idx"',
  'GIT_INDEX_FILE="$idx" g read-tree "$head"',
  'GIT_INDEX_FILE="$idx" g add -A',
  'tree=$(GIT_INDEX_FILE="$idx" g write-tree)',
  "snap=$(GIT_AUTHOR_NAME=sf GIT_AUTHOR_EMAIL=sf@invalid GIT_COMMITTER_NAME=sf GIT_COMMITTER_EMAIL=sf@invalid \\",
  '  g commit-tree "$tree" -p "$head" -m "software factory: the sprite\'s working tree")',
  'g update-ref refs/software-factory/snapshot "$snap"',
  'b="$tmp/sf-result.bundle"; rm -f "$b"',
  'g bundle create "$b" refs/software-factory/snapshot "^$base" >/dev/null 2>&1',
  'printf \'{"head":"%s","snapshot":"%s","unmerged":%s,"mergeHead":"%s"}\\n\' "$head" "$snap" "$unmerged" "$merge"',
  'cat "$b"',
]);

/** The toolchain (`packages/runner-local/sprite/provision.sh`): `$1` Claude Code's version, `$2` the prefix. */
export const PROVISION_FILE = fileURLToPath(new URL("../../sprite/provision.sh", import.meta.url));
export const DOCKERFILE = fileURLToPath(new URL("../../container/Dockerfile", import.meta.url));

/** The provision script, as run with `sh -c` (its shebang and comments kept). */
export function provisionScript(): string {
  return readFileSync(PROVISION_FILE, "utf8");
}

/** The Claude Code version the agent image pins (`ARG CLAUDE_CODE_VERSION=` in the Dockerfile). */
export function pinnedClaudeVersion(dockerfile = DOCKERFILE): string {
  const m = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(readFileSync(dockerfile, "utf8"));
  if (!m?.[1]) throw new Error(`no ARG CLAUDE_CODE_VERSION in ${dockerfile}`);
  return m[1];
}

/** Where a sprite's pinned Claude Code goes, by version. */
export const toolPrefix = (version: string) => `/opt/software-factory/claude-code-${version}`;

/** The argv that runs a script with its arguments. */
export const scriptArgv = (body: string, args: string[]) => ["sh", "-c", body, "sf", ...args];

/** The name a script marks itself with. */
export function scriptName(body: string): string | null {
  return SCRIPT_MARKER.exec(body)?.[1] ?? null;
}
