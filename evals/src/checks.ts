// `.factory/checks/*.json`: a project's own static checks (the improvement loop's cheapest fix, ADR
// 0230). Each check names the files it applies to and patterns that must not (or must) appear in
// them. The evals suite runs every check over the repo on each CI run, so a check is enforced from
// the commit that adds it, and `factory/verify` (which reads CI) can't pass while one fails.
import { z } from "zod";

export const factoryCheckSchema = z
  .object({
    /** Unique, and the file's basename: `.factory/checks/<name>.json`. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    description: z.string().min(1).max(2_000),
    /** Globs over repo paths (`*` within a segment, `**` across segments). */
    appliesTo: z.array(z.string().min(1)).min(1),
    /** Globs to leave out, e.g. test fixtures. */
    exclude: z.array(z.string().min(1)).default([]),
    /** Regexes (JavaScript, multiline) that must NOT match a file. */
    forbid: z.array(z.string().min(1)).default([]),
    /** Regexes that MUST match every file it applies to. */
    require: z.array(z.string().min(1)).default([]),
    /** What to tell the agent or person when it fails. */
    message: z.string().min(1).max(2_000),
  })
  .strict()
  .refine((c) => c.forbid.length + c.require.length > 0, "a check needs forbid or require");
export type FactoryCheck = z.infer<typeof factoryCheckSchema>;

export interface SourceFile {
  path: string;
  content: string;
}

export interface Violation {
  check: string;
  path: string;
  rule: "forbid" | "require";
  pattern: string;
  message: string;
}

/** `*` matches within a path segment, `**` across them, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function applies(check: FactoryCheck, path: string): boolean {
  const any = (globs: string[]) => globs.some((g) => globToRegExp(g).test(path));
  return any(check.appliesTo) && !any(check.exclude);
}

/** Runs one check over files; returns what it flags (empty: it passes). */
export function runCheck(check: FactoryCheck, files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    if (!applies(check, file.path)) continue;
    for (const pattern of check.forbid) {
      if (new RegExp(pattern, "m").test(file.content)) {
        out.push({
          check: check.name,
          path: file.path,
          rule: "forbid",
          pattern,
          message: check.message,
        });
      }
    }
    for (const pattern of check.require) {
      if (!new RegExp(pattern, "m").test(file.content)) {
        out.push({
          check: check.name,
          path: file.path,
          rule: "require",
          pattern,
          message: check.message,
        });
      }
    }
  }
  return out;
}
