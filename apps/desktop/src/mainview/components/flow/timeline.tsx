// An item's timeline (.kim/mockups/board-and-item-panel.html): a move is one quiet line with what
// happened next beneath it, a comment or an agent's summary is a card from its author, a `card`
// entry is drawn as a rich card from its one shape, and what waits on you comes last: the decision
// with its buttons, or the error with Retry.
import {
  type Decision,
  type FlowCard,
  type TimelineRow,
  when,
} from "@software-factory/client/flow";
import { Button } from "@software-factory/ui/components/button";
import { cn } from "@software-factory/ui/lib/utils";
import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import type * as React from "react";
import { ExternalLink } from "../../lib/external.tsx";
import { OwnerMark } from "./parts.tsx";

export function Timeline({
  rows,
  decision,
  error,
  busy,
  onAction,
  onRetry,
  decisionRef,
}: {
  rows: TimelineRow[];
  decision: Decision | null;
  error: string | null;
  busy: boolean;
  onAction: (action: Decision["actions"][number]) => void;
  onRetry: () => void;
  decisionRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div className="flex flex-col gap-[9px]" data-testid="timeline">
      {rows.map((row) => (
        <Row key={`${row.type}${row.seq}`} row={row} />
      ))}
      {error && <Stopped error={error} busy={busy} onRetry={onRetry} />}
      {decision && (
        <DecisionCard
          decision={decision}
          busy={busy}
          onAction={onAction}
          decisionRef={decisionRef}
        />
      )}
    </div>
  );
}

/** One row of the timeline: a move's line, or an entry's card. The inbox shows a few on their own. */
export function Row({ row }: { row: TimelineRow }) {
  return row.type === "line" ? <Line row={row} /> : <Entry row={row} />;
}

function Line({ row }: { row: Extract<TimelineRow, { type: "line" }> }) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 text-[12px]",
        row.tone === "bad" ? "text-bad" : "text-ink-muted",
      )}
      data-testid="timeline-line"
    >
      <span className="min-w-0">
        <b className={cn("font-medium", row.tone === "bad" ? "text-bad" : "text-ink")}>{row.who}</b>{" "}
        {row.what}
        {row.after && (
          <span className="block pl-0.5 text-ink-faint" data-testid="timeline-after">
            ↳ {row.after}
          </span>
        )}
      </span>
      <time className="ml-auto whitespace-nowrap text-ink-faint">{when(row.at)}</time>
    </div>
  );
}

function Entry({ row }: { row: Extract<TimelineRow, { type: "entry" }> }) {
  const kind = row.by === "system" ? "agent" : row.by;
  return (
    <div
      className="rounded-[10px] border border-line bg-panel px-3 py-2.5"
      data-testid={row.by === "agent" ? "timeline-agent" : "timeline-comment"}
    >
      <div className="mb-1 flex items-center gap-[7px] font-semibold">
        <OwnerMark name={row.who} kind={kind} />
        {row.who}
        <time className="font-normal text-[11.5px] text-ink-faint">{when(row.at)}</time>
      </div>
      {row.text && <p className="mb-2 whitespace-pre-wrap last:mb-0">{row.text}</p>}
      {row.cards.map((card, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an entry's cards never reorder.
        <RichCard key={i} card={card} className={i > 0 ? "mt-2" : undefined} />
      ))}
    </div>
  );
}

/** A rich card from its one shape: a title, rows, checks, bars and a link, each optional. */
export function RichCard({ card, className }: { card: FlowCard; className?: string }) {
  const most = Math.max(1, ...(card.bars ?? []).map((b) => b.max));
  return (
    <div
      className={cn(
        "rounded-lg border border-line-soft bg-board px-[11px] py-[9px] text-[12px]",
        className,
      )}
      data-testid="rich-card"
      data-kind={card.kind}
    >
      <div className="flex justify-between gap-3 font-semibold">
        <span className="min-w-0">{card.title}</span>
        {card.subtitle && (
          <span className="flex-none font-normal text-ink-faint">{card.subtitle}</span>
        )}
      </div>
      {card.rows && card.rows.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {card.rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-ink-muted">{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.bars && card.bars.length > 0 && (
        <div className="mt-1.5 grid gap-1">
          {card.bars.map((b) => (
            <div
              key={b.label}
              className="grid grid-cols-[118px_1fr_28px] items-center gap-2"
              data-testid="rich-bar"
            >
              <span className="truncate">{b.label}</span>
              <span className="h-[5px] overflow-hidden rounded-[3px]">
                <span
                  className="block h-full rounded-[3px] bg-work"
                  style={{ width: `${Math.round((Math.max(0, b.value) / most) * 100)}%` }}
                />
              </span>
              <span className="text-right text-ink-muted">{b.value}</span>
            </div>
          ))}
        </div>
      )}
      {card.checks && card.checks.length > 0 && (
        <div className="mt-[7px] flex flex-wrap gap-3 border-line-soft border-t pt-[7px] text-ink-muted">
          {card.checks.map((c) => (
            <span key={c.label} className="flex items-center gap-1" data-testid="rich-check">
              {c.ok ? (
                <CircleCheckIcon className="size-[13px] text-ok" aria-label="passed" />
              ) : (
                <CircleXIcon className="size-[13px] text-bad" aria-label="failed" />
              )}
              {c.label}
            </span>
          ))}
        </div>
      )}
      {card.link && (
        <ExternalLink href={card.link.url} className="mt-1.5 inline-block text-work">
          {card.link.label}
        </ExternalLink>
      )}
    </div>
  );
}

export function DecisionCard({
  decision,
  busy,
  onAction,
  decisionRef,
}: {
  decision: Decision;
  busy: boolean;
  onAction: (action: Decision["actions"][number]) => void;
  decisionRef?: React.Ref<HTMLDivElement>;
}) {
  const [primary, ...rest] = decision.actions;
  return (
    <div
      ref={decisionRef}
      className="scroll-mt-4 rounded-[10px] border border-need-line bg-need-soft px-3 py-[11px]"
      data-testid="decision-card"
      data-kind={decision.kind}
    >
      <div className="font-semibold">{decision.question}</div>
      {decision.detail && <p className="mt-0.5 mb-[9px] text-need-ink">{decision.detail}</p>}
      <div className="flex gap-[7px]">
        {primary && (
          <Button
            size="md"
            disabled={busy}
            onClick={() => onAction(primary)}
            data-testid="decision-primary"
          >
            {primary.label}
          </Button>
        )}
        {rest.map((a) => (
          <Button
            key={a.label}
            size="md"
            variant="outline"
            disabled={busy}
            onClick={() => onAction(a)}
            data-testid="decision-secondary"
          >
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Stopped({ error, busy, onRetry }: { error: string; busy: boolean; onRetry: () => void }) {
  return (
    <div
      className="rounded-[10px] border border-bad/30 bg-bad/5 px-3 py-[11px]"
      data-testid="item-stopped"
    >
      <div className="font-semibold text-bad">Stopped</div>
      <p className="mt-0.5 mb-[9px] whitespace-pre-wrap">{error}</p>
      <Button size="md" disabled={busy} onClick={onRetry} data-testid="retry">
        Retry
      </Button>
    </div>
  );
}
