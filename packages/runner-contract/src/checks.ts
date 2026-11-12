// The project's checks, run by the runner host itself (ADR 0501, spec 51): the commands a job
// carries, what the host reports for each on the hand-back, and the text a failing check sends back
// into the build session. The agent's own report of checks is never the verdict.
import { z } from "zod";

/** A check's name: what criteria link to, and what the review packet shows. */
export const checkName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][\w .:/-]*$/, "letters, digits, spaces and . _ : / -");

/** One declared check, as a job carries it. */
export const checkCommandSchema = z.object({
  name: checkName,
  /** A shell command line, run in the job's worktree root (through the adapter's `exec`). */
  run: z.string().trim().min(1).max(1_000),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60 * 60_000),
});
export type CheckCommand = z.infer<typeof checkCommandSchema>;

/** The checks a build or verify job runs, and how many times a build session may fix a failure. */
export const jobChecksSchema = z.object({
  commands: z.array(checkCommandSchema).min(1).max(10),
  /** Rounds of "here is the failure, fix it" typed into the same build session (the retry limit). */
  fixRounds: z.number().int().min(0).max(5),
});
export type JobChecks = z.infer<typeof jobChecksSchema>;

/** Where a check can run (ADR 0501): see `executedCheckSchema.isolation`. */
export const CHECK_ISOLATIONS = ["container", "sandbox", "weaker-sandbox"] as const;

/** The longest log tail kept per check. */
export const CHECK_LOG_TAIL_MAX = 8_000;

/** What the host saw when it ran one check, on one commit. */
export const executedCheckSchema = z.object({
  name: checkName,
  command: z.string().max(1_000),
  /** The process's exit code; null when it was killed (a timeout, a cancel). */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean().default(false),
  durationMs: z.number().int().nonnegative(),
  /** The last lines of its combined output. */
  logTail: z.string().max(CHECK_LOG_TAIL_MAX),
  /** The commit the worktree was at, clean, when it ran. */
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** Which fix round this result is from (0 = before any fix). */
  round: z.number().int().min(0).max(10).default(0),
  /**
   * Why the host did not run it (no isolated exec here, a job with no container, the sandbox could
   * not start): never a pass, never a failure a fix round could win. Optional and additive.
   */
  notRun: z.string().max(300).optional(),
  /**
   * Set when the check failed on one of the runner's own limits, as the host saw it from outside
   * (ADR 0501, amended 2026-11-13): "the check hit the runner's memory limit (4 GB). The code under
   * check may be the cause; …". A failed check like any other (never a pass, never "not run"); the
   * host only skips its fix round, so a person decides. Optional and additive.
   */
  limit: z.string().max(300).optional(),
  /**
   * Where it ran (ADR 0501, fourth review): a check container (`container`), the OS sandbox of a
   * Linux runner (`sandbox`), or the weaker OS sandbox of a Mac runner whose owner opted in
   * (`weaker-sandbox`: a process a check leaves can outlive it). The merge gate says so for the
   * weaker one. Optional and additive.
   */
  isolation: z.enum(CHECK_ISOLATIONS).optional(),
});
export type ExecutedCheck = z.infer<typeof executedCheckSchema>;
export type CheckIsolation = (typeof CHECK_ISOLATIONS)[number];

/** A check passed: it exited 0 and wasn't cut short. */
export const checkPassed = (c: Pick<ExecutedCheck, "exitCode" | "timedOut">) =>
  c.exitCode === 0 && !c.timedOut;

/**
 * What the host reports for a check it would not run: there is no isolated place to run the
 * project's code on this runner (no container `exec`, no OS sandbox). The check fails, so the
 * verdict can't pass on it and a person is asked (ADR 0501, amended 2026-11-12).
 */
export const NOT_RUN_NO_ISOLATION = "not run: no isolated exec on this runner";

/** The `notRun` reason for a runner with no isolated exec. */
export const NO_ISOLATION = NOT_RUN_NO_ISOLATION.slice("not run: ".length);

/** Token shapes a log tail may carry (a test that dumps its env), each with what replaces it. */
const SECRET_SHAPES: readonly [RegExp, string][] = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(Bearer|token)(\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1$2[redacted]"],
  // NAME_TOKEN=…, AWS_SECRET_ACCESS_KEY=…, DB_PASSWORD: … (env dumps, config prints)
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("?)[^\s"]{4,}\3/gi,
    "$1$2$3[redacted]$3",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted private key]",
  ],
];

/**
 * A log tail with secrets taken out (ADR 0501): known token shapes, `NAME_TOKEN=…` style
 * assignments, private keys, and the job's own secrets (`known`, e.g. its job tokens) wherever
 * they appear. The host redacts before the hand-back; the cloud redacts again before it stores.
 */
export function redactSecrets(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

/** The end of `text`, at most `max` characters, cut at a line where it can. */
export function logTail(text: string, max = CHECK_LOG_TAIL_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf("\n");
  return nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut;
}

/** The most a failure message may be: it is typed into the session as one steer (STEER_MAX). */
export const CHECK_FAILURE_MAX = 1_900;

/**
 * What the host types into the build session when checks fail (ADR 0501): the exact failure (the
 * command, the exit code, the end of its output), never a summary. It goes in as one steer, so it
 * is one line within CHECK_FAILURE_MAX; the log tails share what's left after the fixed text.
 */
export function checkFailureMessage(failed: readonly ExecutedCheck[], round: number): string {
  const head = `The factory ran the project's checks on your commits and ${failed.length === 1 ? "one failed" : `${failed.length} failed`} (fix round ${round}).`;
  const tail =
    "Fix the cause in the code, commit, and finish again. Don't skip, delete or weaken a test or a check: the factory flags that for a person.";
  const lines = failed.map(
    (c) =>
      `Check "${c.name}" failed: \`${c.command}\` ${c.timedOut ? "timed out" : `exited with ${c.exitCode ?? "a signal"}`} after ${Math.round(c.durationMs / 1000)} s on ${c.headSha.slice(0, 7)}. End of its output:`,
  );
  const fixed = [head, ...lines, tail].join(" ").length + failed.length * 8;
  const each = Math.max(80, Math.floor((CHECK_FAILURE_MAX - fixed) / Math.max(1, failed.length)));
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const body = failed.map((c, i) => {
    const out = flat(c.logTail);
    return `${lines[i]} «${out.length > each ? `…${out.slice(-each)}` : out}»`;
  });
  const message = [head, ...body, tail].join(" ");
  return message.length > CHECK_FAILURE_MAX ? message.slice(0, CHECK_FAILURE_MAX) : message;
}
