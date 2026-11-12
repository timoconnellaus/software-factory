// What the factory proved itself (spec 51 PR B, ADR 0501), in the desktop shell's look: the
// project's checks as the runner host ran them on the packet's commit, and each criterion's mark,
// Proven only by a check the approved spec links it to that passed there. The reviewer's words and
// its own links are opinion. A packet from before has neither section: the criteria show the
// reviewer's met / not met, as they did.
import {
  type CheckOutcome,
  type CriterionProof,
  type ParsedPacket,
  packetExecuted,
} from "@software-factory/client/packet";
import type { Status } from "@software-factory/ui/components/status-dot";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Panel, SectionTitle } from "./shell-list.tsx";

/** A check the host did not run (no isolation, no container, no sandbox): never a pass. */
const notRun = (r: CheckOutcome) => r.exitCode === null && r.logTail.startsWith("not run");

function outcome(r: CheckOutcome): string {
  if (r.passed) return `exit ${r.exitCode}`;
  if (notRun(r)) return "not run";
  return r.timedOut ? "timed out" : `exit ${r.exitCode ?? "signal"}`;
}

/** The project's checks as the runner host ran them on this commit (ADR 0501). */
export function FactoryChecks({ packet }: { packet: ParsedPacket }) {
  const executed = packetExecuted(packet);
  if (!executed) return null; // a packet from before the factory ran checks itself
  const rows = [...executed.rows, ...executed.extra.map((r) => ({ name: r.name, result: r }))];
  const note = executed.ranOn
    ? `Ran on ${executed.ranOn.slice(0, 7)}, not on ${packet.headSha.slice(0, 7)}: the merge queue carried this packet to the updated head.`
    : `Run by the runner host on ${packet.headSha.slice(0, 7)}, not reported by an agent.`;
  return (
    <section className="flex flex-col gap-2" data-testid="factory-checks">
      <SectionTitle note={note}>Checks run by the factory</SectionTitle>
      {rows.length === 0 ? (
        <Panel className="text-ink-muted">
          The project declares no checks: only CI backs this verdict.
        </Panel>
      ) : (
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
                      <code className="font-mono">{result.command}</code> · {outcome(result)} ·{" "}
                      {Math.max(1, Math.round(result.durationMs / 1000))} s
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
    </section>
  );
}

/** A criterion's mark (ADR 0501): proven by a check, met only in the reviewer's opinion, or unmet. */
export function criterionMark(
  met: boolean,
  proof: CriterionProof | undefined,
): { status: Status; label: string } {
  if (!met) return { status: "waiting", label: "Not met" };
  if (!proof) return { status: "done", label: "Met" }; // a packet from before: the reviewer's word
  return proof.proven
    ? { status: "done", label: "Proven" }
    : { status: "waiting", label: "Not proven" };
}

/** Under a criterion: what proved it (or why nothing did), who linked it, the reviewer's opinion. */
export function CriterionProofNote({ proof }: { proof: CriterionProof }) {
  const linked = proof.provenBy.length + proof.unproven.length + proof.notCounted.length > 0;
  return (
    <div className="mt-0.5 flex flex-col gap-0.5 text-xs" data-testid="criterion-proof">
      <div className="font-medium text-ink-2">
        {proof.proven ? `Proven by ${proof.provenBy.join(", ")}` : "Not proven"}
        {proof.weakened && (
          <span className="font-normal text-amber-700 dark:text-amber-400">
            {" "}
            · weakened: gate files changed on this commit (see Tests intact)
          </span>
        )}
        {!proof.proven && proof.unproven.length > 0 && (
          <span className="font-normal text-ink-3">
            {" "}
            (linked {proof.unproven.join(", ")}: didn't pass on this commit)
          </span>
        )}
      </div>
      {linked && (
        <div className="text-ink-3" data-testid="criterion-linked-by">
          {proof.linkedBy === "spec"
            ? "Linked in the approved spec"
            : "Linked by the reviewer, not proven"}
          {proof.notCounted.length > 0 &&
            ` · ${proof.notCounted.join(", ")} passed but can't prove a criterion (a static check, or a link the approved spec doesn't make)`}
        </div>
      )}
    </div>
  );
}
