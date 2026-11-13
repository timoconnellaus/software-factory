// SF Runner.app's entry table (spec 45 §1, Entry points), as the CLI checks it. The launcher
// (apps/desktop/native/sf-runner-launcher) refuses any command line outside launcher-entries.json
// before Node starts; under the service the CLI checks its own arguments against the same table
// again, so a launcher bug can't widen what runs. Both run test/fixtures/launcher-entry-cases.json.
import table from "./launcher-entries.json" with { type: "json" };

interface Form {
  words: string[];
  flags?: Record<string, string | null>;
  required?: string[];
  exclusive?: string[][];
  requires?: Record<string, string>;
}

export interface Entry {
  script: string | null;
  fixed: string[];
  fd3?: boolean;
  forms: Form[];
}

export const ENTRIES: Record<string, Entry> = table.entries as Record<string, Entry>;
export const MAX_ARGUMENT_BYTES = 2048;

/** Whether `value` is of the grammar's `type`: `<name>`, `<url>`, or `a|b` (one of those words). */
export function valueMatches(type: string, value: string): boolean {
  if (type === "<name>") return /^[A-Za-z0-9._-]{1,64}$/.test(value);
  if (type === "<url>") return isPlainHttpsUrl(value);
  return type.split("|").includes(value);
}

/** An `https:` URL with a host and no user info, at most 2 KiB, nothing but printable ASCII. */
export function isPlainHttpsUrl(value: string): boolean {
  if (Buffer.byteLength(value) > MAX_ARGUMENT_BYTES || !/^[\x21-\x7e]+$/.test(value)) return false;
  // The launcher (URLComponents) and this agree only on URLs that state a host; insist on one.
  if (!/^https:\/\/[^/?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function match(args: string[], form: Form): string[] | null {
  if (args.length < form.words.length) return null;
  for (const [i, word] of form.words.entries()) {
    const arg = args[i] as string;
    if (word.startsWith("<") ? !valueMatches(word, arg) : word !== arg) return null;
  }
  const flags = form.flags ?? {};
  const seen = new Set<string>();
  for (let i = form.words.length; i < args.length; ) {
    const flag = args[i] as string;
    if (!Object.hasOwn(flags, flag) || seen.has(flag)) return null;
    seen.add(flag);
    const type = flags[flag];
    if (type == null) {
      i += 1;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || !valueMatches(type, value)) return null;
    i += 2;
  }
  if ((form.required ?? []).some((f) => !seen.has(f))) return null;
  if ((form.exclusive ?? []).some((group) => group.filter((f) => seen.has(f)).length > 1))
    return null;
  if (Object.entries(form.requires ?? {}).some(([f, needs]) => seen.has(f) && !seen.has(needs)))
    return null;
  return args;
}

/** The entry and the script's arguments for a launcher command line, or null (exit 64). */
export function chooseEntry(
  args: string[],
): { name: string; entry: Entry; scriptArgs: string[] } | null {
  if (args.some((a) => Buffer.byteLength(a) > MAX_ARGUMENT_BYTES)) return null;
  if (args[0] === "") return null;
  const name = args[0] ?? "";
  if (!Object.hasOwn(ENTRIES, name)) return null;
  const entry = ENTRIES[name] as Entry;
  const rest = args.slice(args.length ? 1 : 0);
  for (const form of entry.forms) {
    const parsed = match(rest, form);
    if (parsed) return { name, entry, scriptArgs: [...entry.fixed, ...parsed] };
  }
  return null;
}

/**
 * Under the service, whether the CLI's own arguments are what some entry of `script` hands it:
 * the CLI refuses anything else (spec 45 §1). Outside the service (a checkout) everything goes.
 */
export function cliArgsAllowed(
  script: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.SF_RUNNER_SERVICE !== "1") return true;
  for (const [name, entry] of Object.entries(ENTRIES)) {
    if (entry.script !== script) continue;
    if (!entry.fixed.every((f, i) => argv[i] === f)) continue;
    const callerArgs = argv.slice(entry.fixed.length);
    const chosen = chooseEntry(name === "" ? callerArgs : [name, ...callerArgs]);
    if (chosen && chosen.entry === entry) return true;
  }
  return false;
}
