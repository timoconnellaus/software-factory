// The Planning tab (mockup planning, ADR 0042): open questions with their default and
// recommendation, "Accept remaining defaults", the answered ones, and the living spec beside them.
// Approving the spec is the spec gate.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useState } from "react";
import Markdown from "react-markdown";
import type { WorkItemDetail } from "#/lib/ops";
import { answerChoices, bulkAcceptable } from "#/lib/questions";
import { NoteDialog, useDecide } from "./decisions.tsx";

type Question = WorkItemDetail["questions"][number];

export function Planning({ detail }: { detail: WorkItemDetail }) {
  const { item, questions } = detail;
  const { decide, pending } = useDecide();
  const [changes, setChanges] = useState(false);
  const open = questions.filter((q) => q.status === "open");
  const answered = questions.filter((q) => q.status !== "open");
  const accepted = answered.filter((q) => q.acceptedDefault).length;
  const specGate = detail.gates.find((g) => g.kind === "spec" && g.status === "pending");
  const canApprove = !!specGate && detail.viewer.isApprover;
  const bulk = open.filter(bulkAcceptable).length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-muted-foreground text-sm" data-testid="planning-progress">
          {answered.length} of {questions.length} questions answered · {accepted} accepted defaults
          {item.domains.length > 0 && ` · touches ${item.domains.join(", ")}`}
        </div>
        <span className="grow" />
        {open.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={bulk === 0 || pending !== null}
            title={bulk === 0 ? "The open questions need an answer one by one" : undefined}
            onClick={() => decide({ kind: "question.acceptDefaults", workItemId: item.id })}
            data-testid="accept-defaults"
          >
            Accept remaining defaults
          </Button>
        )}
        {specGate && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!canApprove || pending !== null}
              onClick={() => setChanges(true)}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              disabled={!canApprove || pending !== null}
              title={
                canApprove ? undefined : "Only an approver on this project can approve the spec"
              }
              onClick={() => decide({ kind: "spec.approve", workItemId: item.id })}
              data-testid="approve-spec"
            >
              Approve spec
            </Button>
          </>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="grid content-start gap-3">
          {questions.length === 0 && (
            <Card className="px-5 py-6 text-muted-foreground text-sm">
              {item.specRequired === false
                ? `No planning: ${item.specDecisionReason ?? "triage skipped the spec"}.`
                : "No questions yet. The spec agent asks them while it writes the spec."}
            </Card>
          )}
          {open.map((q, i) => (
            <QuestionForm
              key={q.id}
              question={q}
              index={answered.length + i + 1}
              workItemId={item.id}
            />
          ))}
          {answered.length > 0 && (
            <Card className="gap-2 px-5 py-4" data-testid="answered">
              <div className="font-semibold text-sm">Answered</div>
              {answered.map((q, i) => (
                <div key={q.id} className="flex items-start gap-2 text-sm">
                  <StatusDot status="done" className="mt-1.5" />
                  <div>
                    <span className="text-muted-foreground">
                      {i + 1}. {q.prompt}
                    </span>{" "}
                    <b className="font-medium">{q.answer ?? "—"}</b>{" "}
                    <span className="text-muted-foreground text-xs">
                      ·{" "}
                      {q.acceptedDefault
                        ? "default"
                        : q.answer === q.defaultAnswer
                          ? "default"
                          : "changed"}
                    </span>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
        <LivingSpec detail={detail} />
      </div>

      <NoteDialog
        open={changes}
        onOpenChange={setChanges}
        title="Request changes to the spec"
        description="The spec goes back to planning with your note; it comes back to you for approval."
        confirm="Send back to planning"
        onConfirm={(note) => decide({ kind: "spec.requestChanges", workItemId: item.id, note })}
      />
    </div>
  );
}

function QuestionForm({
  question,
  index,
  workItemId,
}: {
  question: Question;
  index: number;
  workItemId: string;
}) {
  const choices = answerChoices(question);
  const [choice, setChoice] = useState<string>(choices[0]?.answer ?? "");
  const [other, setOther] = useState("");
  const { decide, pending } = useDecide();
  const answer = choice === "__other" ? other.trim() : choice;
  return (
    <Card className="gap-3 px-5 py-4 shadow-waiting" data-testid={`question-${question.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <span>Question {index}</span>
        <Badge variant="outline">{question.domain}</Badge>
        {question.blocking && <span>blocking</span>}
        {question.irreversible && (
          <span className="text-status-waiting">irreversible · answer it yourself</span>
        )}
      </div>
      <div className="font-semibold">{question.prompt}</div>
      <fieldset className="grid gap-1.5">
        <legend className="sr-only">{question.prompt}</legend>
        {choices.map((c) => (
          <label
            key={c.answer}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
              choice === c.answer && "border-foreground/40 bg-accent",
            )}
          >
            <input
              type="radio"
              name={question.id}
              value={c.answer}
              checked={choice === c.answer}
              onChange={() => setChoice(c.answer)}
            />
            <span className="grow">{c.answer}</span>
            {c.tag && <span className="text-muted-foreground text-xs">{c.tag}</span>}
          </label>
        ))}
        <label
          className={cn(
            "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
            choice === "__other" && "border-foreground/40 bg-accent",
          )}
        >
          <input
            type="radio"
            name={question.id}
            value="__other"
            checked={choice === "__other"}
            onChange={() => setChoice("__other")}
            className="mt-1"
          />
          <span className="grid grow gap-1.5">
            Something else
            {choice === "__other" && (
              <Textarea
                rows={2}
                value={other}
                onChange={(e) => setOther(e.target.value)}
                autoFocus
              />
            )}
          </span>
        </label>
      </fieldset>
      {question.recommendation && question.recommendation !== question.defaultAnswer && (
        <div className="text-muted-foreground text-xs">
          Recommended: {question.recommendation}
          {question.defaultAnswer ? ` · default if nobody answers: ${question.defaultAnswer}` : ""}
        </div>
      )}
      <div>
        <Button
          size="sm"
          disabled={!answer || pending !== null}
          onClick={() =>
            decide({ kind: "question.answer", workItemId, questionId: question.id, answer })
          }
        >
          Answer
        </Button>
      </div>
    </Card>
  );
}

function LivingSpec({ detail }: { detail: WorkItemDetail }) {
  const { spec } = detail;
  const pendingCount = detail.questions.filter((q) => q.status === "open").length;
  return (
    <Card className="content-start gap-0 py-0" data-testid="living-spec">
      <div className="flex flex-wrap items-center gap-2 border-b px-5 pt-4 pb-3">
        <div className="font-semibold">Spec (living)</div>
        {spec && (
          <Badge variant="outline">
            v{spec.version} · {spec.status}
          </Badge>
        )}
        <span className="grow" />
        <span className="font-mono text-muted-foreground text-xs">
          → {spec?.path ?? "docs/specs/ on the work item's branch"}
        </span>
      </div>
      {!spec ? (
        <div className="px-5 py-4 text-muted-foreground text-sm">
          No spec yet. It's written by the spec agent as the questions are answered; approving it is
          the spec gate.
        </div>
      ) : (
        <div className="grid gap-4 px-5 py-4 text-sm">
          <div className="text-muted-foreground text-xs">
            Written by the spec agent as you answer
            {pendingCount
              ? ` (${pendingCount} question${pendingCount === 1 ? "" : "s"} still open)`
              : ""}
            . Approving it is the spec gate; it's then committed to the work item's branch
            {spec.commitSha ? ` (${spec.commitSha.slice(0, 7)})` : ""}.
          </div>
          <div className="text-sm [&_h1]:font-semibold [&_h1]:text-base [&_h2]:mt-3 [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5 [&_code]:font-mono [&_code]:text-xs">
            <Markdown>{spec.bodyMd}</Markdown>
          </div>
          <div>
            <b>Acceptance criteria</b>
            <ul className="mt-1.5 grid gap-1.5">
              {spec.acceptanceCriteria.map((c) => (
                <li key={c} className="flex items-start gap-2">
                  <StatusDot status="idle" className="mt-1.5" />
                  {c}
                </li>
              ))}
            </ul>
          </div>
          {spec.assumptions.length > 0 && (
            <div data-testid="assumptions">
              <b>Assumptions</b>
              <span className="text-muted-foreground text-xs">
                {" "}
                · reversible choices the agent made instead of asking
              </span>
              <ul className="mt-1.5 grid gap-1.5">
                {spec.assumptions.map((a) => (
                  <li key={a} className="flex items-start gap-2">
                    <Badge variant="outline" className="shrink-0">
                      assumption
                    </Badge>
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
