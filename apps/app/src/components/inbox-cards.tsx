// Inbox cards (spec 12, mockup home-inbox): spec approval, ready to merge, a question, and any
// other gate. Cards that need you get the waiting ring; status is a dot.

import { ago } from "@software-factory/client/format";
import { checkCounts, packetCounts, parsePacket } from "@software-factory/client/packet";
import { answerChoices } from "@software-factory/client/questions";
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { StatusBadge } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Inbox } from "#/lib/ops";
import { workItemQuery } from "#/lib/queries";
import { NoteDialog, useDecide } from "./decisions.tsx";

type Gate = Inbox["gates"][number];
type Question = Inbox["questions"][number];

function CardShell({
  highlighted,
  testId,
  children,
}: {
  highlighted: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        "gap-0 py-0 shadow-waiting transition-colors",
        highlighted && "bg-accent/60 ring-2 ring-status-waiting",
      )}
      data-testid={testId}
    >
      {children}
    </Card>
  );
}

function Head({
  label,
  meta,
  title,
  workItemId,
  incident,
  children,
}: {
  label: string;
  meta: string;
  title: string;
  workItemId: string | null;
  incident?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="px-5 pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status="waiting">{label}</StatusBadge>
        {incident && <Badge variant="outline">Factory incident</Badge>}
        <span className="text-muted-foreground text-xs">{meta}</span>
      </div>
      <div className="mt-2 font-semibold text-[15px] tracking-tight">
        {workItemId ? (
          <Link to="/work/$id" params={{ id: workItemId }} className="hover:underline">
            {title}
          </Link>
        ) : (
          title
        )}
      </div>
      {children}
    </div>
  );
}

export function GateCard({
  gate,
  projectName,
  highlighted,
}: {
  gate: Gate;
  projectName: string;
  highlighted: boolean;
}) {
  if (gate.kind === "spec" && gate.workItemId)
    return <SpecGateCard gate={gate} projectName={projectName} highlighted={highlighted} />;
  if (gate.kind === "merge" && gate.workItemId)
    return <MergeGateCard gate={gate} projectName={projectName} highlighted={highlighted} />;
  return <ApprovalCard gate={gate} projectName={projectName} highlighted={highlighted} />;
}

function SpecGateCard({
  gate,
  projectName,
  highlighted,
}: {
  gate: Gate;
  projectName: string;
  highlighted: boolean;
}) {
  const id = gate.workItemId as string;
  const item = useQuery(workItemQuery(id));
  const { decide, pending } = useDecide();
  const [changes, setChanges] = useState(false);
  const d = item.data;
  const facts = d
    ? [
        `${d.spec?.acceptanceCriteria.length ?? 0} acceptance criteria`,
        d.item.size ? `sized ${d.item.size}` : null,
        d.item.domains.length ? `touches ${d.item.domains.join(", ")}` : null,
      ].filter(Boolean)
    : [];
  return (
    <CardShell highlighted={highlighted} testId={`card-${id}`}>
      <Head
        label="Spec approval"
        meta={`${projectName} · from ${d?.item.source ?? "app"} · ${ago(gate.createdAt)}${gate.escalated ? " · escalated" : ""}`}
        title={gate.title}
        workItemId={id}
        incident={d?.item.kind === "incident"}
      >
        <div className="mt-1 text-muted-foreground text-sm">{facts.join(" · ")}</div>
        {d?.item.specDecisionReason && (
          <div className="mt-1 text-muted-foreground text-xs">
            Triage: {d.item.specDecisionReason}
          </div>
        )}
      </Head>
      <div className="flex flex-wrap gap-2 px-5 pt-4 pb-5">
        <Button
          size="sm"
          disabled={pending !== null}
          onClick={() => decide({ kind: "spec.approve", workItemId: id })}
          data-testid="approve-spec"
        >
          Approve spec
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link to="/work/$id" params={{ id }} search={{ tab: "planning" }}>
            Read spec
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => setChanges(true)}
        >
          Request changes
        </Button>
      </div>
      <NoteDialog
        open={changes}
        onOpenChange={setChanges}
        title="Request changes to the spec"
        description="The spec goes back to planning with your note, and comes back to you for approval."
        confirm="Send back to planning"
        onConfirm={(note) => decide({ kind: "spec.requestChanges", workItemId: id, note })}
      />
    </CardShell>
  );
}

function MergeGateCard({
  gate,
  projectName,
  highlighted,
}: {
  gate: Gate;
  projectName: string;
  highlighted: boolean;
}) {
  const id = gate.workItemId as string;
  const item = useQuery(workItemQuery(id));
  const { decide, pending } = useDecide();
  const [sendBack, setSendBack] = useState(false);
  const d = item.data;
  const packet = d?.reviewPacket ? parsePacket(d.reviewPacket) : null;
  const counts = packet ? packetCounts(packet) : null;
  const checks = packet ? checkCounts(packet) : null;
  const canMerge = d?.viewer.isApprover ?? false;
  return (
    <CardShell highlighted={highlighted} testId={`card-${id}`}>
      <Head
        label="Ready to merge"
        meta={`${projectName}${d?.item.prNumber ? ` · PR #${d.item.prNumber}` : ""} · ${ago(gate.createdAt)}`}
        title={gate.title}
        workItemId={id}
        incident={d?.item.kind === "incident"}
      >
        {packet && counts && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <span className={checks?.failed ? "text-destructive" : undefined}>
              {checks?.failed ? "✗" : "✓"} {checks?.source === "ci" ? "CI" : "Checks"}{" "}
              {checks?.passed}/{checks?.total}
            </span>
            <span>
              {counts.met === counts.total ? "✓" : "✗"} {counts.met}/{counts.total} criteria
            </span>
            {packet.reviewer && (
              <span>
                {packet.reviewer.verdict === "approve"
                  ? "✓ Reviewer approved"
                  : "✗ Reviewer asked for changes"}
              </span>
            )}
            {packet.riskFlags.length > 0 && (
              <span className="text-muted-foreground">{packet.riskFlags.length} risk flags</span>
            )}
          </div>
        )}
      </Head>
      <div className="flex flex-wrap gap-2 px-5 pt-4 pb-5">
        <Button size="sm" asChild>
          <Link to="/work/$id/review" params={{ id }}>
            Open review packet
          </Link>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canMerge || pending !== null}
          title={canMerge ? undefined : "Only an approver on this project can merge"}
          onClick={() => decide({ kind: "review.merge", workItemId: id, openedFullDiff: false })}
          data-testid="merge"
        >
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => setSendBack(true)}
        >
          Send back
        </Button>
      </div>
      <NoteDialog
        open={sendBack}
        onOpenChange={setSendBack}
        title="Send back to build"
        description="The work item goes back to build with your note. A factory incident opens to fix .factory/ so this doesn't happen again."
        confirm="Send back"
        destructive
        onConfirm={(note) =>
          decide({ kind: "review.sendBack", workItemId: id, note, openedFullDiff: false })
        }
      />
    </CardShell>
  );
}

function ApprovalCard({
  gate,
  projectName,
  highlighted,
}: {
  gate: Gate;
  projectName: string;
  highlighted: boolean;
}) {
  const { decide, pending } = useDecide();
  return (
    <CardShell highlighted={highlighted} testId={`card-${gate.workItemId ?? gate.id}`}>
      <Head
        label="Approval"
        meta={`${projectName} · ${gate.operation} · ${ago(gate.createdAt)}`}
        title={gate.title}
        workItemId={gate.workItemId}
      />
      <div className="flex flex-wrap gap-2 px-5 pt-4 pb-5">
        <Button
          size="sm"
          disabled={pending !== null}
          onClick={() =>
            decide({
              kind: "approval.decide",
              pendingActionId: gate.id,
              decision: "approved",
              ...(gate.workItemId ? { workItemId: gate.workItemId } : {}),
            })
          }
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() =>
            decide({
              kind: "approval.decide",
              pendingActionId: gate.id,
              decision: "rejected",
              ...(gate.workItemId ? { workItemId: gate.workItemId } : {}),
            })
          }
        >
          Reject
        </Button>
      </div>
    </CardShell>
  );
}

export function QuestionCard({
  question,
  projectName,
  highlighted,
}: {
  question: Question;
  projectName: string;
  highlighted: boolean;
}) {
  const { decide, pending } = useDecide();
  const [reply, setReply] = useState(false);
  const answer = (text: string) =>
    decide({
      kind: "question.answer",
      workItemId: question.workItemId,
      questionId: question.id,
      answer: text,
    });
  const choices = answerChoices(question).slice(0, 4);
  return (
    <CardShell highlighted={highlighted} testId={`card-${question.workItemId}`}>
      <Head
        label="Question"
        meta={`${projectName} · ${question.domain}${question.irreversible ? " · irreversible" : ""}`}
        title={question.prompt}
        workItemId={null}
      >
        <div className="mt-1 text-muted-foreground text-sm">
          On{" "}
          <Link
            to="/work/$id"
            params={{ id: question.workItemId }}
            search={{ tab: "planning" }}
            className="underline"
          >
            {question.title}
          </Link>
        </div>
      </Head>
      <div className="flex flex-wrap gap-2 px-5 pt-4 pb-5">
        {choices.map((c, i) => (
          <Button
            key={c.answer}
            size="sm"
            variant={i === 0 ? "default" : "outline"}
            disabled={pending !== null}
            onClick={() => answer(c.answer)}
          >
            {c.answer}
            {c.tag && <span className="font-normal text-xs opacity-70">· {c.tag}</span>}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => setReply(true)}
        >
          Reply…
        </Button>
      </div>
      <NoteDialog
        open={reply}
        onOpenChange={setReply}
        title="Answer in your own words"
        description={question.prompt}
        confirm="Answer"
        onConfirm={answer}
      />
    </CardShell>
  );
}
