// Reading a parser's error as a message and a place (after kim's `design/errors.ts`): @dbml/parse
// diagnostics, D2's `index:L:C: message`, yaml's linePos, Mermaid's jison hash or "on line N".
export interface Problem {
  message: string;
  line: number | null;
  column: number | null;
}

/** Thrown by this package's own readers, already carrying its places. */
export class DesignParseError extends Error {
  constructor(
    message: string,
    readonly problems: Problem[],
  ) {
    super(message);
    this.name = "DesignParseError";
  }
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => typeof v === "object" && v !== null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** D2's errors: a JSON list of `{ errmsg: "index:3:5: message" }`, or lines of the same. */
function d2Problems(message: string): Problem[] {
  let entries: string[];
  try {
    const parsed: unknown = JSON.parse(message);
    entries = Array.isArray(parsed)
      ? parsed.map((e) => (isObject(e) && typeof e.errmsg === "string" ? e.errmsg : ""))
      : [];
  } catch {
    entries = message.split("\n");
  }
  return entries
    .map((e) => /^[^:\n]*:(\d+):(\d+):\s*([\s\S]*)$/.exec(e))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ message: m[3] ?? "", line: Number(m[1]), column: Number(m[2]) }));
}

/** Mermaid's messages carry a code frame: keep the words. */
function mermaidMessage(message: string): string {
  const lines = message.split("\n");
  if (/^Parse error on line \d+:?$/.test(lines[0] ?? "") && lines.length >= 4) {
    const rest = lines.slice(3).join(" ");
    const got = /got '([^']+)'/.exec(rest);
    const wanted = /Expecting (.+), got/.exec(rest);
    const tidy = (t: string) => t.replace(/'/g, "").toLowerCase().replace(/_/g, " ");
    const options = wanted?.[1] ? wanted[1].split(", ").map(tidy) : [];
    const shown =
      options.length > 4
        ? `${options.slice(0, 4).join(", ")} or ${options.length - 4} more`
        : options.join(", ");
    if (got?.[1]) {
      return `Unexpected ${got[1] === "TXT" ? "text" : tidy(got[1])}${shown ? `; expected ${shown}` : ""}`;
    }
    return rest;
  }
  return message.trim() || "This design could not be read.";
}

/** Every problem a parser reported, each at its own place. */
export function describeErrors(error: unknown): Problem[] {
  if (error instanceof DesignParseError) return error.problems;
  if (isObject(error)) {
    if (Array.isArray(error.linePos) && isObject(error.linePos[0])) {
      const message = typeof error.message === "string" ? error.message : "";
      return [
        {
          message: (message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, ""),
          line: num(error.linePos[0].line),
          column: num(error.linePos[0].col),
        },
      ];
    }
    const hash = error.hash;
    if (isObject(hash) && isObject(hash.loc)) {
      const message = typeof error.message === "string" ? error.message : "";
      return [
        {
          message: mermaidMessage(message),
          line: num(hash.loc.first_line),
          column: (num(hash.loc.first_column) ?? 0) + 1,
        },
      ];
    }
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "This design could not be read.";
  const d2 = d2Problems(message);
  if (d2.length) return d2;
  const onLine = /\bon line (\d+)/i.exec(message);
  return [
    { message: mermaidMessage(message), line: onLine ? Number(onLine[1]) : null, column: null },
  ];
}
