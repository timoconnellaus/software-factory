// The review packet (spec 14, mockup review-packet). In the app it IS the merge gate (ADR 0041):
// Merge calls review.merge, Send back calls review.sendBack, and both record whether the full diff
// was opened first. Rendered only from the stored packet: no GitHub calls on load.

import {
  type CriterionProof,
  checkCounts,
  keptOnRunner,
  type PacketSection,
  type ParsedPacket,
  packetCounts,
  packetExecuted,
  packetExtras,
  packetProof,
  packetSections,
  packetTestsIntact,
  parsePacket,
} from "@software-factory/client/packet";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { type Status, StatusBadge, StatusDot } from "@software-factory/ui/components/status-dot";
import { Table, TableBody, TableCell, TableRow } from "@software-factory/ui/components/table";
import { cn } from "@software-factory/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { WorkItemDetail } from "#/lib/ops";
import { useSession } from "#/lib/session";
import { NoteDialog, useDecide } from "./decisions.tsx";

const OPENED_KEY = (id: string) => `sf:opened-diff:${id}`;

/** Whether the approver opened the full diff (or the GitHub PR) for this head SHA. */
function useOpenedFullDiff(workItemId: string, headSha: string | undefined) {
  const key = `${OPENED_KEY(workItemId)}:${headSha ?? ""}`;
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    try {
      setOpened(sessionStorage.getItem(key) === "1");
    } catch {
      // Storage blocked: the flag lives in memory for this page only.
    }
  }, [key]);
  const mark = () => {
    setOpened(true);
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      // ignore
    }
  };
  return [opened, mark] as const;
}

export function ReviewPacket({ detail, full = false }: { detail: WorkItemDetail; full?: boolean }) {
  const { item } = detail;
  const packet = detail.reviewPacket ? parsePacket(detail.reviewPacket) : null;
  const mergeGate = detail.gates.find((g) => g.kind === "merge" && g.status === "pending");
  const [opened, markOpened] = useOpenedFullDiff(item.id, packet?.headSha);
  const { decide, pending } = useDecide();
  const [sendBack, setSendBack] = useState(false);
  const canDecide = !!mergeGate && detail.viewer.isApprover;
  const me = useSession().user.id;
  const approverNames = detail.approvers.users.map((u) =>
    u.id === me ? "you" : (u.githubLogin ?? u.name),
  );
  const prFiles = item.prUrl ? `${item.prUrl}/files` : null;

  if (!packet) {
    return (
      <Card className="items-center py-10 text-center text-sm" data-testid="no-packet">
        <div className="font-medium">No review packet yet</div>
        <div className="text-muted-foreground">
          The verify stage assembles it once the build has a PR.
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-4" data-testid="review-packet">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {full && (
            <div className="mb-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <StatusBadge
                status={mergeGate ? "waiting" : packet.verdict === "pass" ? "done" : "failed"}
              >
                {mergeGate ? "Ready to merge" : gateOutcome(detail)}
              </StatusBadge>
            </div>
          )}
          {full && <h1 className="font-semibold text-2xl tracking-tight">{item.title}</h1>}
          <div className="text-muted-foreground text-sm">
            {item.prUrl && item.prNumber ? (
              <a
                href={item.prUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
                onClick={markOpened}
                data-testid="pr-link"
              >
                PR #{item.prNumber}
              </a>
            ) : (
              "No PR yet"
            )}{" "}
            · head <span className="font-mono text-xs">{packet.headSha.slice(0, 7)}</span> ·
            approver: {approverNames.join(", ") || "nobody"} ({detail.approvers.rule})
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!canDecide || pending !== null}
            onClick={() => setSendBack(true)}
            data-testid="send-back"
          >
            Send back
          </Button>
          {prFiles && (
            <Button variant="outline" asChild>
              <a href={prFiles} target="_blank" rel="noreferrer" onClick={markOpened}>
                View diff
              </a>
            </Button>
          )}
          <Button
            disabled={!canDecide || pending !== null}
            title={
              !mergeGate
                ? "There is no open merge gate"
                : detail.viewer.isApprover
                  ? undefined
                  : "Only an approver on this project can merge"
            }
            onClick={() =>
              decide({ kind: "review.merge", workItemId: item.id, openedFullDiff: opened })
            }
            data-testid="merge"
          >
            {pending === "review.merge" ? "Merging…" : "Merge"}
          </Button>
        </div>
      </div>

      {/* Always shown, whatever sections the project picks: it's for a person (ADR 0500). */}
      <TestsIntact packet={packet} currentHead={item.headSha} />
      <FactoryChecks packet={packet} />

      {packetSections(detail.policy?.reviewPacketSections).map((section) => (
        <Section
          key={section}
          section={section}
          packet={packet}
          detail={detail}
          onOpenDiff={markOpened}
        />
      ))}

      <Card className="gap-1 px-5 py-4 text-sm" data-testid="merge-footer">
        <div className="font-medium">Merge</div>
        <div className="text-muted-foreground">
          Merge always needs a person (the floor): the factory never merges on its own. The GitHub
          App merges the PR with a merge commit once you decide here.
          {mergeGate ? "" : ` ${gateOutcome(detail)}.`}
        </div>
        <div className="text-muted-foreground text-xs">
          {opened ? "You opened the full diff." : "You haven't opened the full diff yet."} That's
          recorded with your decision.
        </div>
      </Card>

      <NoteDialog
        open={sendBack}
        onOpenChange={setSendBack}
        title="Send back to build"
        description="The work item goes back to build with your note (it shows on the timeline). A factory incident opens to fix .factory/ so it doesn't happen again."
        placeholder="What's wrong, and what should change?"
        confirm="Send back"
        destructive
        onConfirm={(note) =>
          decide({ kind: "review.sendBack", workItemId: item.id, note, openedFullDiff: opened })
        }
      />
    </div>
  );
}

function gateOutcome(detail: WorkItemDetail): string {
  const last = [...detail.gates].reverse().find((g) => g.kind === "merge");
  if (!last) return "Not at the merge gate yet";
  if (last.decision === "approved") return "Merged";
  if (last.decision === "sent_back") return "Sent back";
  return last.status === "pending" ? "Ready to merge" : capitalise(last.decision ?? last.status);
}

const capitalise = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

function Section({
  section,
  packet,
  detail,
  onOpenDiff,
}: {
  section: PacketSection;
  packet: ParsedPacket;
  detail: WorkItemDetail;
  onOpenDiff: () => void;
}) {
  switch (section) {
    case "verdict":
      return <VerdictRow packet={packet} />;
    case "whatChanged":
      return (
        <Panel title="What changed" testId="section-whatChanged">
          {packet.summary ? (
            <div className="prose-sm text-sm [&_code]:font-mono [&_code]:text-xs [&_p]:my-1">
              <Markdown>{packet.summary}</Markdown>
            </div>
          ) : (
            <Empty>No summary.</Empty>
          )}
          <ChangedFiles packet={packet} />
        </Panel>
      );
    case "criteria": {
      const proof = packetProof(packet);
      return (
        <Panel
          title="Acceptance criteria · evidence"
          subtitle={
            proof
              ? "Proven only by a check that passed on this commit; the reviewer's words are opinion"
              : undefined
          }
          testId="section-criteria"
          flush
        >
          {packet.criteria.length === 0 ? (
            <div className="px-5 pb-4">
              <Empty>The packet has no criteria.</Empty>
            </div>
          ) : (
            <Table className="w-full text-sm">
              <TableBody>
                {packet.criteria.map((c) => {
                  const runner = keptOnRunner(c.evidence);
                  return (
                    <TableRow key={c.criterion} className="border-t align-top" data-met={c.met}>
                      <TableCell className="w-10 py-2.5 pr-2 pl-5">
                        <StatusDot
                          status={criterionStatus(c, proof?.get(c.criterion))}
                          className="mt-1.5"
                        />
                        <span className="sr-only">
                          {criterionLabel(c, proof?.get(c.criterion))}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-normal py-2.5 pr-3">{c.criterion}</TableCell>
                      <TableCell className="whitespace-normal py-2.5 pr-5 text-muted-foreground text-xs">
                        {runner ? (
                          <span data-testid="kept-on-runner">kept on runner · {runner}</span>
                        ) : (
                          <CriterionEvidence
                            evidence={c.evidence}
                            proof={proof?.get(c.criterion)}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      );
    }
    case "holdout": {
      const holdout = packet.sections.holdout ?? packet.sections.holdouts;
      return (
        <Panel
          title="Holdout tests"
          subtitle="Written from the approved criteria, never shown to the build"
          testId="section-holdout"
        >
          {Array.isArray(holdout) && holdout.length ? (
            <ul className="grid gap-1 text-sm">
              {holdout.map((h, i) => {
                const t = h as { name?: string; status?: string };
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stored list, never reordered.
                  <li key={i} className="flex items-center gap-2">
                    <StatusDot
                      status={
                        t.status === "pass" ? "done" : t.status === "fail" ? "failed" : "idle"
                      }
                    />
                    {t.name ?? JSON.stringify(h)}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>No holdout results in this packet.</Empty>
          )}
        </Panel>
      );
    }
    case "reviewer":
      return (
        <Panel
          title="Reviewer notes"
          subtitle={
            packet.reviewer
              ? `Independent review · role ${packet.reviewer.role}${packet.reviewer.model ? ` (${packet.reviewer.model})` : ""}`
              : undefined
          }
          testId="section-reviewer"
        >
          {packet.reviewer ? (
            <div className="grid gap-2 text-sm">
              {packet.reviewer.sameModelAsImplementer ? (
                <div className="flex items-center gap-2 text-xs" data-testid="same-model-warning">
                  <StatusDot status="waiting" />
                  The reviewer ran on the same model as the implementer: it is less independent.
                </div>
              ) : (
                <div className="text-muted-foreground text-xs">
                  A different model from the implementer.
                </div>
              )}
              <div className="flex items-center gap-2">
                <StatusDot status={packet.reviewer.verdict === "approve" ? "done" : "failed"} />
                <b>{packet.reviewer.verdict === "approve" ? "Approve" : "Request changes"}</b>
              </div>
              <div className="whitespace-pre-wrap text-sm">
                {packet.reviewer.notes || "No notes."}
              </div>
            </div>
          ) : (
            <Empty>No reviewer verdict.</Empty>
          )}
        </Panel>
      );
    case "visual": {
      const shots = packet.sections.visual ?? packet.sections.screenshots;
      return (
        <Panel
          title="Visual evidence"
          subtitle="Captured by the runner's browser"
          testId="section-visual"
        >
          {Array.isArray(shots) && shots.length ? (
            <ul className="grid gap-1 text-sm">
              {shots.map((s, i) => {
                const label =
                  typeof s === "string"
                    ? s
                    : ((s as { label?: string; ref?: string }).label ?? JSON.stringify(s));
                const ref = typeof s === "string" ? s : ((s as { ref?: string }).ref ?? "");
                const runner = keptOnRunner(ref);
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stored list, never reordered.
                  <li key={i}>{runner ? `${label} · kept on runner (${runner})` : label}</li>
                );
              })}
            </ul>
          ) : (
            <Empty>No screenshots in this packet.</Empty>
          )}
        </Panel>
      );
    }
    case "risk":
      return (
        <Panel title="Risk flags" testId="section-risk">
          {packet.riskFlags.length ? (
            <ul className="grid gap-1 text-sm">
              {packet.riskFlags.map((r) => (
                <li key={r} className="flex items-center gap-2">
                  <StatusDot status="waiting" />
                  {r}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>None.</Empty>
          )}
        </Panel>
      );
    case "diff": {
      const diff = packet.sections.diff;
      return (
        <Collapsible
          className="group/collapsible rounded-xl border px-5 py-4 text-sm"
          onOpenChange={(open) => (open ? onOpenDiff() : undefined)}
          data-testid="section-diff"
        >
          <CollapsibleTrigger className="flex items-center gap-1 text-left cursor-pointer font-semibold">
            <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
            Diff
          </CollapsibleTrigger>
          <CollapsibleContent>
            {typeof diff === "string" && diff ? (
              <pre className="mt-3 max-h-[480px] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                {diff}
              </pre>
            ) : (
              <div className="mt-2 text-muted-foreground">
                The packet doesn't carry the diff.{" "}
                {detail.item.prUrl ? (
                  <a
                    href={`${detail.item.prUrl}/files`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                    onClick={onOpenDiff}
                  >
                    Open it on GitHub
                  </a>
                ) : (
                  "There is no PR yet."
                )}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      );
    }
  }
}

/** A criterion's mark (ADR 0501): proven by a check, met only in the reviewer's opinion, or unmet. */
function criterionStatus(c: { met: boolean }, proof: CriterionProof | undefined): Status {
  if (!c.met) return "failed";
  if (!proof) return "done"; // a packet from before: the reviewer's word, as it was shown then
  return proof.proven ? "done" : "waiting";
}
function criterionLabel(c: { met: boolean }, proof: CriterionProof | undefined): string {
  if (!c.met) return "not met";
  if (!proof) return "met";
  return proof.proven ? "proven" : "not proven";
}

function CriterionEvidence({
  evidence,
  proof,
}: {
  evidence: string;
  proof: CriterionProof | undefined;
}) {
  if (!proof) return <>{evidence || "no evidence"}</>;
  return (
    <div className="grid gap-0.5" data-testid="criterion-proof" data-proven={proof.proven}>
      <div className="font-medium text-foreground">
        {proof.proven ? `Proven by ${proof.provenBy.join(", ")}` : "Not proven"}
        {proof.weakened && (
          <span className="font-normal text-amber-700 dark:text-amber-400">
            {" "}
            · weakened: gate files changed on this commit (see Tests intact)
          </span>
        )}
        {!proof.proven && proof.unproven.length > 0 && (
          <span className="font-normal text-muted-foreground">
            {" "}
            (linked {proof.unproven.join(", ")}: didn't pass on this commit)
          </span>
        )}
      </div>
      {(proof.provenBy.length > 0 || proof.unproven.length > 0 || proof.notCounted.length > 0) && (
        <div className="text-muted-foreground text-xs" data-testid="criterion-linked-by">
          {proof.linkedBy === "spec"
            ? "Linked in the approved spec"
            : "Linked by the reviewer, not proven"}
          {proof.notCounted.length > 0 &&
            ` · ${proof.notCounted.join(", ")} passed but can't prove a criterion (a static check, or a link the approved spec doesn't make)`}
        </div>
      )}
      <div>Reviewer's opinion: {evidence || "no evidence"}</div>
    </div>
  );
}

/** The project's checks as the runner host ran them on this commit (ADR 0501). */
function FactoryChecks({ packet }: { packet: ParsedPacket }) {
  const executed = packetExecuted(packet);
  if (!executed) return null; // a packet from before the factory ran checks itself
  const rows = [...executed.rows, ...executed.extra.map((r) => ({ name: r.name, result: r }))];
  return (
    <Panel
      title="Checks run by the factory"
      subtitle={
        executed.ranOn
          ? `Ran on ${executed.ranOn.slice(0, 7)}, not on ${packet.headSha.slice(0, 7)}: the merge queue carried this packet to the updated head`
          : `Run by the runner host on ${packet.headSha.slice(0, 7)}, not reported by an agent`
      }
      testId="section-factoryChecks"
    >
      {rows.length === 0 ? (
        <Empty>The project declares no checks: only CI backs this verdict.</Empty>
      ) : (
        <ul className="grid gap-2 text-sm">
          {rows.map(({ name, result }) => (
            <li key={name} className="grid gap-1" data-testid="factory-check">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot status={!result ? "idle" : result.passed ? "done" : "failed"} />
                <b>{name}</b>
                {result ? (
                  <span className="text-muted-foreground text-xs">
                    <code className="font-mono">{result.command}</code> ·{" "}
                    {result.timedOut ? "timed out" : `exit ${result.exitCode ?? "signal"}`} ·{" "}
                    {Math.max(1, Math.round(result.durationMs / 1000))} s
                    {result.round
                      ? ` · after ${result.round} fix round${result.round === 1 ? "" : "s"}`
                      : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">didn't run on this commit</span>
                )}
              </div>
              {result && !result.passed && result.logTail && (
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                  {result.logTail}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The tests-intact guard (ADR 0500): found in code from the diff, for a person, not the reviewer. */
function TestsIntact({
  packet,
  currentHead,
}: {
  packet: ParsedPacket;
  currentHead: string | null;
}) {
  const t = packetTestsIntact(packet);
  const sha = packet.headSha.slice(0, 7);
  const total = t ? (t.total ?? t.findings.length) : 0;
  return (
    <Panel
      title="Tests intact"
      subtitle="Checked by the factory from the diff on GitHub, not by an agent"
      testId="section-testsIntact"
    >
      <div className="grid gap-2 text-sm">
        {currentHead && currentHead !== packet.headSha && (
          <div className="flex items-start gap-2 text-xs" data-testid="tests-intact-stale">
            <StatusDot status="waiting" className="mt-1" />
            <span>
              This was checked on <span className="font-mono">{sha}</span>, but the branch is now at{" "}
              <span className="font-mono">{currentHead.slice(0, 7)}</span>, which hasn't been
              checked yet.
            </span>
          </div>
        )}
        {!t ? (
          <Empty>Not checked: this packet is from before the guard.</Empty>
        ) : t.intact ? (
          <div className="grid gap-1" data-testid="tests-intact">
            <div className="flex items-start gap-2">
              <StatusDot status="done" className="mt-1.5" />
              <span>
                No findings on <span className="font-mono">{sha}</span>: no test deleted, removed,
                skipped or commented out, no suppression added, no threshold lowered, no gate file
                changed.
              </span>
            </div>
            <div className="text-muted-foreground text-xs">
              This checks the diff's shape only. It can't see a test weakened from inside, such as
              <code className="font-mono"> expect(true)</code>, an emptied body or{" "}
              <code className="font-mono">if (false)</code>.
            </div>
          </div>
        ) : (
          <>
            <div className="text-muted-foreground text-xs">
              {total} finding{total === 1 ? "" : "s"} on <span className="font-mono">{sha}</span>
              {total > t.findings.length ? ` (the first ${t.findings.length} are listed)` : ""}.
              They don't fail verify; you decide whether each is right. The factory never merges
              this on its own.
            </div>
            <ul className="grid gap-1.5" data-testid="test-findings">
              {t.findings.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stored list, never reordered.
                <li key={i} className="flex items-start gap-2">
                  <StatusDot status="waiting" className="mt-1.5" />
                  <div className="min-w-0">
                    {/* The message is Markdown for factory/verify; here its backticks are noise. */}
                    <div>{f.message.replaceAll("`", "")}</div>
                    {f.path && (
                      <div className="font-mono text-muted-foreground text-xs">
                        {f.path}
                        {f.line ? `:${f.line}` : ""}
                        {f.text ? ` · ${f.text}` : ""}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}

function VerdictRow({ packet }: { packet: ParsedPacket }) {
  const c = packetCounts(packet);
  const checks = checkCounts(packet);
  const extras = packetExtras(packet);
  const proof = packetProof(packet);
  const proven = proof ? [...proof.values()].filter((x) => x.proven).length : 0;
  const cells: { label: string; value: string; status: Status; extra?: string }[] = [
    {
      label: checks.source === "ci" ? "CI on the head SHA" : "Checks (runner)",
      value: checks.total ? `${checks.passed}/${checks.total} passed` : "none reported",
      status: checks.failed
        ? "failed"
        : checks.total && checks.passed === checks.total
          ? "done"
          : checks.total
            ? "running"
            : "idle",
    },
    proof
      ? {
          // ADR 0501: proven by an executed check, not by the reviewer's say-so.
          label: "Criteria",
          value: `${proven}/${c.total} proven`,
          status: c.met < c.total ? "failed" : c.total && proven === c.total ? "done" : "waiting",
          ...(c.total > proven && c.met === c.total
            ? { extra: "rest: opinion" }
            : proof && [...proof.values()].some((x) => x.weakened)
              ? { extra: "weakened: gate files changed" }
              : {}),
        }
      : {
          label: "Criteria",
          value: `${c.met}/${c.total} met`,
          status: c.total && c.met === c.total ? "done" : "failed",
        },
    {
      label: "Reviewer (role review)",
      value: packet.reviewer
        ? packet.reviewer.verdict === "approve"
          ? "Approve"
          : "Request changes"
        : "none",
      status: packet.reviewer
        ? packet.reviewer.verdict === "approve"
          ? "done"
          : "failed"
        : "idle",
      ...(packet.reviewer?.sameModelAsImplementer ? { extra: "same model" } : {}),
    },
    {
      label: "Risk",
      value: packet.riskFlags[0] ?? "No flags",
      status: packet.riskFlags.length ? "waiting" : "done",
      ...(packet.riskFlags.length > 1 ? { extra: `+${packet.riskFlags.length - 1}` } : {}),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="section-verdict">
      {cells.map((cell) => (
        <Card key={cell.label} className="gap-1 px-4 py-3">
          <div className="text-muted-foreground text-xs">{cell.label}</div>
          <div className="flex items-center gap-2 text-sm">
            <StatusDot status={cell.status} />
            <b className="truncate">{cell.value}</b>
            {cell.extra && <span className="text-muted-foreground text-xs">{cell.extra}</span>}
          </div>
        </Card>
      ))}
      <div className="col-span-full flex items-center gap-2 text-muted-foreground text-xs">
        Verdict: <StatusDot status={packet.verdict === "pass" ? "done" : "failed"} />
        {packet.verdict === "pass" ? "pass" : "fail"} (from CI on the head SHA and the evidence)
      </div>
      {(extras.reasons.length > 0 || extras.warnings.length > 0) && (
        <ul className="col-span-full grid gap-1 text-sm" data-testid="verdict-reasons">
          {extras.reasons.map((r) => (
            <li key={r} className="flex items-start gap-2">
              <StatusDot status="failed" className="mt-1.5" />
              {r}
            </li>
          ))}
          {extras.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2">
              <StatusDot status="waiting" className="mt-1.5" />
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  testId,
  flush = false,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  testId: string;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0" data-testid={testId}>
      <div className="px-5 pt-4 pb-3">
        <div className="font-semibold">{title}</div>
        {subtitle && <div className="text-muted-foreground text-xs">{subtitle}</div>}
      </div>
      <div className={cn(!flush && "px-5 pb-4")}>{children}</div>
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground text-sm">{children}</div>;
}

function ChangedFiles({ packet }: { packet: ParsedPacket }) {
  const { changed } = packetExtras(packet);
  if (!changed || changed.files === null) return null;
  return (
    <Collapsible className="group/collapsible mt-2 text-sm">
      <CollapsibleTrigger className="flex items-center gap-1 text-left cursor-pointer text-muted-foreground">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
        {changed.files} {changed.files === 1 ? "file" : "files"} changed
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1 grid gap-0.5 font-mono text-xs">
          {changed.paths.map((f) => (
            <li key={f.path}>
              <span className="text-muted-foreground">{f.status.padEnd(9, " ")}</span> {f.path}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
