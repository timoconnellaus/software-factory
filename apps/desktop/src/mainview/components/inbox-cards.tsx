// The Inbox's pages (spec 12; restyled for spec 41, design InboxMerge/InboxQuestion): what the
// selected entry in the Inbox list is, and the decision it waits for. Every decision goes through
// `useDecide()`, so Touch ID confirms it (ADR 0391); only the look changed.

import { ago } from "@software-factory/client/format";
import type { Inbox } from "@software-factory/client/ops";
import { parsePacket } from "@software-factory/client/packet";
import { answerChoices } from "@software-factory/client/questions";
import { Button } from "@software-factory/ui/components/button";
import { Label } from "@software-factory/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { NoteDialog, useDecide } from "../lib/decisions.tsx";
import { op } from "../lib/op.ts";
import { useRefreshAfterDecision, workItemQuery } from "../lib/queries.ts";
import { type Withdrawal, withdrawnBefore, withdrawnText } from "../lib/withdrawn.ts";
import { ResolutionSummary, resolutionNeedsFullDiff } from "./resolution.tsx";
import { CriteriaList, MergeDecision, useOpenedFullDiff, VerdictPanel } from "./review-parts.tsx";
import { Chip, Field, PageHeader, Panel, SectionTitle } from "./shell-list.tsx";

type Gate = Inbox["gates"][number];
type Question = Inbox["questions"][number];
type Planning = Inbox["planning"][number];
type ReleaseFlag = Inbox["releaseFlags"][number];

/** The line above a decision's title: its kind as a chip, then the item and project in mono. */
function Above({ kind, meta }: { kind: string; meta: string }) {
  return (
    <>
      <Chip>{kind}</Chip>
      &nbsp; <span className="font-mono text-[11.5px] text-ink-muted">{meta}</span>
    </>
  );
}

function TwoColumns({ main, side }: { main: React.ReactNode; side: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <div className="flex min-w-0 flex-[999_1_400px] flex-col gap-[18px]">{main}</div>
      <aside className="flex min-w-[260px] flex-[1_1_272px] flex-col gap-3">{side}</aside>
    </div>
  );
}

export function GateDetail({ gate, projectName }: { gate: Gate; projectName: string }) {
  if (gate.kind === "merge" && gate.workItemId)
    return <MergeDetail gate={gate} workItemId={gate.workItemId} projectName={projectName} />;
  if (gate.kind === "spec" && gate.workItemId)
    return <SpecDetail gate={gate} workItemId={gate.workItemId} projectName={projectName} />;
  return <ApprovalDetail gate={gate} projectName={projectName} />;
}

function MergeDetail({
  gate,
  workItemId,
  projectName,
}: {
  gate: Gate;
  workItemId: string;
  projectName: string;
}) {
  const item = useQuery(workItemQuery(workItemId));
  const d = item.data;
  const packet = d?.reviewPacket ? parsePacket(d.reviewPacket) : null;
  const [opened] = useOpenedFullDiff(workItemId, packet?.headSha);
  const meta = [
    d?.item.prNumber ? `PR #${d.item.prNumber}` : null,
    packet ? `head ${packet.headSha.slice(0, 7)}` : null,
    projectName,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-4" data-testid={`card-${workItemId}`}>
      <PageHeader
        above={<Above kind="Merge" meta={meta} />}
        title={`${d ? `#${d.item.number} ` : ""}${gate.title}`}
        sub="Everything below was checked at this commit. A new push withdraws it."
        testId="inbox-title"
      />
      {d && withdrawnBefore(d.gates) && (
        <Panel needsYou data-testid="approval-withdrawn">
          {withdrawnText(withdrawnBefore(d.gates) as Withdrawal, ago)}
        </Panel>
      )}
      {!d ? (
        <Skeleton className="h-48 w-full" />
      ) : !packet ? (
        <Panel className="text-ink-muted">The review packet isn't ready yet.</Panel>
      ) : (
        <TwoColumns
          main={
            <>
              {/* A reopened gate after the babysitter's resolution says so first (spec 53). */}
              <ResolutionSummary detail={d} />
              <VerdictPanel packet={packet} />
              <section className="flex flex-col gap-2">
                <SectionTitle>Acceptance criteria</SectionTitle>
                <CriteriaList packet={packet} />
              </section>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <Link
                  to="/work/$id"
                  params={{ id: workItemId }}
                  search={{ tab: "review" }}
                  className="font-medium underline"
                >
                  Open the full review
                </Link>
                <span className="text-ink-muted text-xs">
                  checks, reviewer notes, what changed and the diff
                </span>
              </div>
            </>
          }
          side={
            // A resolution that isn't clean, or can't be shown, isn't decided from the Inbox: the
            // whole diff is the review (#201 review).
            resolutionNeedsFullDiff(d) ? (
              <Panel className="gap-1.5" data-testid="inbox-merge-elsewhere">
                <div className="font-semibold">Decide from the item's review</div>
                <div className="text-ink-muted">
                  The babysitter resolved a conflict, and there's more than the conflict to look at:
                  open the full diff there before you merge.
                </div>
              </Panel>
            ) : (
              <MergeDecision detail={d} packet={packet} opened={opened} />
            )
          }
        />
      )}
    </div>
  );
}

function SpecDetail({
  gate,
  workItemId,
  projectName,
}: {
  gate: Gate;
  workItemId: string;
  projectName: string;
}) {
  const item = useQuery(workItemQuery(workItemId));
  const { decide, pending } = useDecide();
  const [changes, setChanges] = useState(false);
  const d = item.data;
  const criteria = d?.spec?.acceptanceCriteria ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid={`card-${workItemId}`}>
      <PageHeader
        above={<Above kind="Spec" meta={`${d ? `#${d.item.number} · ` : ""}${projectName}`} />}
        title={`${d ? `#${d.item.number} ` : ""}${gate.title}`}
        sub={
          d?.item.specDecisionReason
            ? `Triage: ${d.item.specDecisionReason}`
            : "The plan is ready for your approval."
        }
        testId="inbox-title"
      />
      <TwoColumns
        main={
          <section className="flex flex-col gap-2">
            <SectionTitle note="Set in the spec, proven in verify">
              Acceptance criteria
            </SectionTitle>
            {criteria.length === 0 ? (
              <Panel className="text-ink-muted">The spec has no criteria yet.</Panel>
            ) : (
              <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel">
                {criteria.map((c) => (
                  <div key={c} className="border-line-soft border-t px-3.5 py-3 first:border-t-0">
                    {c}
                  </div>
                ))}
              </div>
            )}
            <Link
              to="/work/$id"
              params={{ id: workItemId }}
              search={{ tab: "plan" }}
              className="w-fit font-medium underline"
            >
              Read the plan
            </Link>
          </section>
        }
        side={
          <Panel needsYou className="gap-2.5" data-testid="decision">
            <h2 className="m-0 font-semibold text-[13px]">Your decision</h2>
            {(d?.spec?.splitInto ?? 0) !== 0 ? (
              // A split is approved where its work items are shown (spec 24, review of #173).
              <>
                <p className="m-0 font-medium" data-testid="inbox-split">
                  {(d?.spec?.splitInto ?? 0) > 0
                    ? `A plan and ${d?.spec?.splitInto} work items`
                    : "A plan whose split can't be read"}
                </p>
                <Button asChild>
                  <Link to="/work/$id" params={{ id: workItemId }} search={{ tab: "plan" }}>
                    Open the plan to approve
                  </Link>
                </Button>
              </>
            ) : (
              <Button
                // Only once the item has loaded (review of #169): a split must open the plan.
                disabled={pending !== null || !d || item.isError}
                onClick={() => decide({ kind: "spec.approve", workItemId })}
                data-testid="approve-spec"
              >
                Approve the spec
              </Button>
            )}
            <Button variant="outline" disabled={pending !== null} onClick={() => setChanges(true)}>
              Request changes
            </Button>
            <p className="m-0 text-ink-3 leading-normal">
              Approving lets the build start. Changes go back to planning with your note.
            </p>
          </Panel>
        }
      />
      <NoteDialog
        open={changes}
        onOpenChange={setChanges}
        title="Request changes to the spec"
        description="The spec goes back to planning with your note, and comes back to you for approval."
        confirm="Send back to planning"
        onConfirm={(note) => decide({ kind: "spec.requestChanges", workItemId, note })}
      />
    </div>
  );
}

function ApprovalDetail({ gate, projectName }: { gate: Gate; projectName: string }) {
  const { decide, pending } = useDecide();
  const decideAs = (decision: "approved" | "rejected") =>
    decide({
      kind: "approval.decide",
      pendingActionId: gate.id,
      decision,
      ...(gate.workItemId ? { workItemId: gate.workItemId } : {}),
    });
  return (
    <div className="flex flex-col gap-4" data-testid={`card-${gate.workItemId ?? gate.id}`}>
      <PageHeader
        above={<Above kind="Approval" meta={`${gate.operation} · ${projectName}`} />}
        title={gate.title}
        sub={`Asked ${ago(gate.createdAt)}${gate.escalated ? ", escalated" : ""}.`}
        testId="inbox-title"
      />
      <TwoColumns
        main={
          gate.workItemId ? (
            <Link to="/work/$id" params={{ id: gate.workItemId }} className="w-fit underline">
              Open the work item
            </Link>
          ) : null
        }
        side={
          <Panel needsYou className="gap-2.5" data-testid="decision">
            <h2 className="m-0 font-semibold text-[13px]">Your decision</h2>
            <Button disabled={pending !== null} onClick={() => decideAs("approved")}>
              Approve
            </Button>
            <Button
              variant="outline"
              disabled={pending !== null}
              onClick={() => decideAs("rejected")}
            >
              Reject
            </Button>
          </Panel>
        }
      />
    </div>
  );
}

const ELSE = "__else__";

export function QuestionDetail({
  question,
  number,
  projectName,
}: {
  question: Question;
  number: number | null;
  projectName: string;
}) {
  const { decide, pending } = useDecide();
  const choices = answerChoices(question);
  const [choice, setChoice] = useState(choices[0]?.answer ?? ELSE);
  const [note, setNote] = useState("");
  const answer = choice === ELSE ? note.trim() : choice;
  const send = (text: string, withNote: boolean) =>
    decide({
      kind: "question.answer",
      workItemId: question.workItemId,
      questionId: question.id,
      answer: text,
      ...(withNote && note.trim() ? { note: note.trim() } : {}),
    });
  const itemLabel = `${number ? `#${number} ` : ""}${question.title}`;
  return (
    <div className="flex flex-col gap-4" data-testid={`card-${question.workItemId}`}>
      <PageHeader
        above={<Above kind="Question" meta={`${itemLabel} · ${projectName}`} />}
        title={question.prompt}
        testId="inbox-title"
      />
      <TwoColumns
        main={
          <>
            <RadioGroup value={choice} onValueChange={setChoice} className="gap-2.5">
              {[...choices, { answer: ELSE, tag: null }].map((c) => (
                <Label
                  key={c.answer}
                  className={cn(
                    "flex min-h-12 cursor-pointer items-center gap-3 rounded-[10px] bg-panel px-3.5 py-3 font-normal shadow-panel",
                    choice === c.answer && "shadow-[0_0_0_1.5px_var(--ink)]",
                  )}
                >
                  <RadioGroupItem value={c.answer} />
                  <span className="font-medium">
                    {c.answer === ELSE ? "Something else" : c.answer}
                  </span>
                  {c.tag && <span className="text-ink-muted">{c.tag}</span>}
                </Label>
              ))}
            </RadioGroup>
            <Field
              htmlFor="question-note"
              label={choice === ELSE ? "Your answer" : "Add a note for the agent"}
            >
              <Textarea
                id="question-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="note-input"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending !== null || !answer}
                onClick={() => send(answer, choice !== ELSE)}
                data-testid="answer"
              >
                Answer
              </Button>
              {question.defaultAnswer && (
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => send(question.defaultAnswer as string, false)}
                >
                  Accept the default
                </Button>
              )}
            </div>
          </>
        }
        side={
          <Panel className="gap-2">
            <h2 className="m-0 font-semibold text-[13px]">About this question</h2>
            <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-3 gap-y-2">
              <dt className="text-ink-3">Domain</dt>
              <dd className="m-0">{question.domain}</dd>
              <dt className="text-ink-3">Blocks</dt>
              <dd className="m-0">{itemLabel}</dd>
              {question.defaultAnswer && (
                <>
                  <dt className="text-ink-3">Default</dt>
                  <dd className="m-0">{question.defaultAnswer}</dd>
                </>
              )}
              {question.irreversible && (
                <>
                  <dt className="text-ink-3">Note</dt>
                  <dd className="m-0">Irreversible: it can't be changed later</dd>
                </>
              )}
            </dl>
            <Link
              to="/work/$id"
              params={{ id: question.workItemId }}
              search={{ tab: "plan" }}
              className="w-fit underline"
            >
              Open {number ? `#${number}` : "the work item"}
            </Link>
          </Panel>
        }
      />
    </div>
  );
}

export function PlanningDetail({
  planning,
  projectName,
}: {
  planning: Planning;
  projectName: string;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid={`planning-${planning.workItemId}`}>
      <PageHeader
        above={<Above kind="Spec" meta={`#${planning.number} · ${projectName}`} />}
        title={`#${planning.number} ${planning.title}`}
        sub={
          planning.atGate
            ? "The spec is ready for your approval."
            : "Planning has a first draft: read it and answer what's open."
        }
        testId="inbox-title"
      />
      <Panel needsYou className="gap-2.5">
        <div className="flex items-center gap-2">
          <StatusDot status={planning.atGate ? "waiting" : "running"} />
          {planning.openQuestions
            ? `${planning.openQuestions} open question${planning.openQuestions === 1 ? "" : "s"}`
            : "No open questions"}
          <span className="text-ink-muted">· announced {ago(planning.announcedAt)}</span>
        </div>
        <Button asChild className="w-fit">
          <Link to="/work/$id" params={{ id: planning.workItemId }} search={{ tab: "plan" }}>
            Open the plan
          </Link>
        </Button>
      </Panel>
    </div>
  );
}

/**
 * A shaped item flagged at release (spec 52, Q4): its workflow's shaping stages changed since it
 * was shaped. The person chooses: shape it again under the current workflow, or accept the shaping
 * done and deliver it under the current workflow. Delivery runs on the current version either way.
 */
export function ReleaseFlagDetail({
  flag,
  projectName,
}: {
  flag: ReleaseFlag;
  projectName: string;
}) {
  const refresh = useRefreshAfterDecision();
  const [busy, setBusy] = useState<"reshape" | "accept" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (choice: "reshape" | "accept") => {
    setBusy(choice);
    setError(null);
    try {
      const r = await op("workItem.releaseChoice", { workItemId: flag.workItemId, choice });
      // The org's workflow changed again since the flag: the card shows the new difference.
      if (r.refused) setError(r.refused);
      await refresh(flag.workItemId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid={`release-flag-${flag.workItemId}`}>
      <PageHeader
        above={<Above kind="Release" meta={`#${flag.number} · ${projectName}`} />}
        title={`#${flag.number} ${flag.title}`}
        sub={`Shaped under workflow version ${flag.shapedUnder}; its shaping changed in version ${flag.current}.`}
        testId="inbox-title"
      />
      <Panel needsYou className="gap-3">
        <p className="m-0">{flag.reason}</p>
        <p className="m-0 text-ink-muted">Either way it is delivered under the current workflow.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void choose("reshape")}
            disabled={busy !== null}
            data-testid="release-reshape"
          >
            Shape it again
          </Button>
          <Button
            variant="outline"
            onClick={() => void choose("accept")}
            disabled={busy !== null}
            data-testid="release-accept"
          >
            Accept the shaping and release
          </Button>
        </div>
        {error && <p className="m-0 text-destructive">{error}</p>}
      </Panel>
    </div>
  );
}
