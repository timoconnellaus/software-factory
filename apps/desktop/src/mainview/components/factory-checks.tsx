// What the factory proved itself (spec 51 PR B, ADR 0501), in the desktop shell's look: the
// project's checks as the runner host ran them on the packet's commit, and each criterion's mark,
// Proven only by a check the approved spec links it to that passed there. The reviewer's words and
// its own links are opinion. A packet from before has neither section: the criteria show the
// reviewer's met / not met, as they did.
import {
  CHECKS_DOCS_URL,
  type CheckOutcome,
  type CriterionProof,
  type ParsedPacket,
  packetExecuted,
  packetProven,
  whyNotProven,
} from "@software-factory/client/packet";
import type { Status } from "@software-factory/ui/components/status-dot";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { ExternalLink } from "../lib/external.tsx";
import { Panel, SectionTitle } from "./shell-list.tsx";

/**
 * The project has no declared checks and no required CI check reported (the owner's decision,
 * 2026-11-13): nothing could prove a criterion, so the gate says so instead of "0/N proven". No
 * screen declares checks yet, so the link is the docs section.
 */
export function NoChecksNotice() {
  return (
    <Panel className="gap-1" data-testid="no-checks">
      <div className="flex items-center gap-2 font-medium">
        <StatusDot status="idle" />
        No checks are set up for this project, so nothing can be proven.
      </div>
      <div className="text-ink-3 text-xs">
        The marks below are the reviewer's opinion.{" "}
        <ExternalLink
          href={CHECKS_DOCS_URL}
          className="text-ink-2 underline underline-offset-2"
          data-testid="no-checks-link"
        >
          How to set up checks
        </ExternalLink>
      </div>
    </Panel>
  );
}

/** False when the packet says nothing was set up that could prove a criterion. */
export const noChecksSetUp = (packet: ParsedPacket) => packetProven(packet)?.checksSetUp === false;

/** A check the host did not run (no isolation, no container, no sandbox): never a pass. */
const notRun = (r: CheckOutcome) =>
  !!r.notRun || (r.exitCode === null && r.logTail.startsWith("not run"));

function outcome(r: CheckOutcome): string {
  if (r.passed) return `exit ${r.exitCode}`;
  if (notRun(r)) return "not run";
  return r.timedOut ? "timed out" : `exit ${r.exitCode ?? "signal"}`;
}

/** The project's checks as the runner host ran them on this commit (ADR 0501). */
export function FactoryChecks({ packet }: { packet: ParsedPacket }) {
  const executed = packetExecuted(packet);
  if (!executed) return null; // a packet from before the factory ran checks itself
  // Nothing set up at all: the criteria say so once (NoChecksNotice), not twice.
  if (noChecksSetUp(packet) && executed.rows.length === 0 && executed.extra.length === 0) {
    return null;
  }
  // Checks not run have a heading of their own, apart from failures (fourth review, S2).
  const all = [...executed.rows, ...executed.extra.map((r) => ({ name: r.name, result: r }))];
  const rows = all.filter(({ result }) => !result || !notRun(result));
  const skipped = all.filter(({ result }) => result && notRun(result));
  const note = executed.ranOn
    ? `Ran on ${executed.ranOn.slice(0, 7)}, not on ${packet.headSha.slice(0, 7)}: the merge queue carried this packet to the updated head.`
    : `Run by the runner host on ${packet.headSha.slice(0, 7)}, not reported by an agent.`;
  return (
    <section className="flex flex-col gap-2" data-testid="factory-checks">
      <SectionTitle note={note}>Checks run by the factory</SectionTitle>
      {executed.weaker.length > 0 && (
        <Panel className="text-amber-700 dark:text-amber-400" data-testid="checks-weaker">
          Ran in the weaker sandbox of a Mac runner whose owner opted in (
          {executed.weaker.join(", ")}): a process a check leaves can outlive it.
        </Panel>
      )}
      {rows.length === 0 && skipped.length === 0 ? (
        <Panel className="text-ink-muted">
          The project declares no checks: only CI backs this verdict.
        </Panel>
      ) : rows.length === 0 ? null : (
        <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel">
          {rows.map(({ name, result }) => (
            <div
              key={name}
              className="flex flex-col gap-1.5 border-line-soft border-t px-3.5 py-2.5 first:border-t-0"
              data-testid="factory-check"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot status={!result ? "idle" : result.passed ? "done" : "failed"} />
                <span className="font-mono text-[12.5px]">{name}</span>
                <span className="text-ink-3 text-xs">
                  {result ? (
                    <>
                      <code className="font-mono">{result.command}</code> · {outcome(result)}
                      {` · ${Math.max(1, Math.round(result.durationMs / 1000))} s`}
                      {result.round
                        ? ` · after ${result.round} fix round${result.round === 1 ? "" : "s"}`
                        : ""}
                    </>
                  ) : (
                    "didn't run on this commit"
                  )}
                </span>
              </div>
              {result && !result.passed && result.logTail && (
                <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
                  {result.logTail}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
      {skipped.length > 0 && (
        <>
          <SectionTitle
            note={
              executed.waived
                ? `Merged without them by a person's decision, ${executed.waived.at.slice(0, 10)}.`
                : "Not failures, not passes: the criteria they would prove are Not proven. You decide."
            }
          >
            Not run on this runner
          </SectionTitle>
          <div
            className="overflow-hidden rounded-[10px] bg-panel shadow-panel"
            data-testid="checks-not-run"
          >
            {skipped.map(({ name, result }) => (
              <div
                key={name}
                className="flex flex-col gap-1 border-line-soft border-t px-3.5 py-2.5 first:border-t-0"
                data-testid="factory-check-not-run"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusDot status="waiting" />
                  <span className="font-mono text-[12.5px]">{name}</span>
                  <code className="font-mono text-ink-3 text-xs">{result?.command}</code>
                </div>
                <div className="text-amber-700 text-xs dark:text-amber-400">
                  {result?.notRun ??
                    executed.notRun.find((n) => n.name === name)?.reason ??
                    "not run"}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** A criterion's mark (ADR 0501): proven by a check, met only in the reviewer's opinion, or unmet. */
export function criterionMark(
  met: boolean,
  proof: CriterionProof | undefined,
  noChecks = false,
): { status: Status; label: string } {
  if (!met) return { status: "waiting", label: "Not met" };
  // No checks set up: nothing could prove it, so the mark is the reviewer's, said as such.
  if (noChecks) return { status: "idle", label: "Met (opinion)" };
  if (!proof) return { status: "done", label: "Met" }; // a packet from before: the reviewer's word
  return proof.proven
    ? { status: "done", label: "Proven" }
    : { status: "waiting", label: "Not proven" };
}

/** Under a criterion: what proved it (or why nothing did), who linked it, the reviewer's opinion. */
export function CriterionProofNote({ proof }: { proof: CriterionProof }) {
  return (
    <div className="mt-0.5 flex flex-col gap-0.5 text-xs" data-testid="criterion-proof">
      <div className="font-medium text-ink-2">
        {proof.proven ? `Proven by ${proof.provenBy.join(", ")}` : "Not proven"}
        {!proof.proven && (
          <span className="font-normal text-ink-3" data-testid="criterion-why">
            {": "}
            {whyNotProven(proof)}
          </span>
        )}
        {proof.weakened && (
          <span className="font-normal text-amber-700 dark:text-amber-400">
            {" "}
            · weakened: gate files changed on this commit (see Tests intact)
          </span>
        )}
      </div>
      {/* Not proven already says why (whyNotProven); proven says who tied it. */}
      {proof.proven && (
        <div className="text-ink-3" data-testid="criterion-linked-by">
          Linked in the approved spec
        </div>
      )}
    </div>
  );
}
