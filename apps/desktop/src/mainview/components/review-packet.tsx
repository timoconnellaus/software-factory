// The review packet (spec 14; restyled for spec 41, design ItemReview). In the app it IS the merge
// gate (ADR 0041): Merge calls review.merge, Send back calls review.sendBack, and both record
// whether the full diff was opened first. Rendered only from the stored packet: no GitHub calls on
// load. Merge and Send back go through `decide()`, so each asks for Touch ID once (ADR 0391); GitHub
// links open in the default browser.

import type { WorkItemDetail } from "@software-factory/client/ops";
import {
  type PacketSection,
  type ParsedPacket,
  packetExtras,
  packetSections,
  packetTestsIntact,
  parsePacket,
} from "@software-factory/client/packet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { ChevronRightIcon } from "lucide-react";
import Markdown from "react-markdown";
import { openExternal } from "../lib/external.tsx";
import { useSession } from "../lib/session.ts";
import { FactoryChecks } from "./factory-checks.tsx";
import { ResolutionPanel } from "./resolution.tsx";
import { CriteriaList, MergeDecision, useOpenedFullDiff, VerdictPanel } from "./review-parts.tsx";
import { Panel, SectionTitle } from "./shell-list.tsx";

export function ReviewPacket({ detail }: { detail: WorkItemDetail }) {
  const { item } = detail;
  const packet = detail.reviewPacket ? parsePacket(detail.reviewPacket) : null;
  const [opened, markOpened] = useOpenedFullDiff(item.id, packet?.headSha);
  const me = useSession().user.id;

  if (!packet) {
    return (
      <Panel className="items-center py-10 text-center" data-testid="no-packet">
        <div className="font-medium">No review packet yet</div>
        <div className="text-ink-muted">The verify stage assembles it once the build has a PR.</div>
      </Panel>
    );
  }
  const approverNames = detail.approvers.users.map((u) =>
    u.id === me ? "you" : (u.githubLogin ?? u.name),
  );
  const sections = packetSections(detail.policy?.reviewPacketSections).filter(
    (s) => s !== "verdict" && s !== "criteria",
  );
  const configured = packetSections(detail.policy?.reviewPacketSections);

  return (
    <div className="flex flex-wrap items-start gap-[18px]" data-testid="review-packet">
      <div className="flex min-w-0 flex-[999_1_400px] flex-col gap-[18px]">
        {/* A babysitter's resolution at the reopened gate: what to review first (spec 53). */}
        <ResolutionPanel detail={detail} onOpenDiff={markOpened} />
        {/* Always shown, whatever sections the project picks: it's for a person (ADR 0500). */}
        <TestsIntact packet={packet} currentHead={item.headSha} />
        {configured.includes("verdict") && (
          <VerdictPanel packet={packet}>
            <div className="text-ink-3 text-xs">
              <span className="font-mono">
                {item.prUrl && item.prNumber ? (
                  <a
                    href={item.prUrl}
                    className="underline"
                    onClick={external(item.prUrl, markOpened)}
                    data-testid="pr-link"
                  >
                    PR #{item.prNumber}
                  </a>
                ) : (
                  "No PR yet"
                )}{" "}
                · head {packet.headSha.slice(0, 7)}
              </span>{" "}
              A new push withdraws this packet and verify runs again.
            </div>
            <VerdictNotes packet={packet} />
          </VerdictPanel>
        )}
        {/* Spec 51 PR B (ADR 0501): what the runner host ran itself, beside the reported checks. */}
        <FactoryChecks packet={packet} />
        <ChecksTable packet={packet} />
        {configured.includes("criteria") && (
          <section className="flex flex-col gap-2">
            <SectionTitle note="As the verify run reported them, with its evidence.">
              Acceptance criteria
            </SectionTitle>
            <CriteriaList packet={packet} />
          </section>
        )}
        {sections.map((section) => (
          <Section
            key={section}
            section={section}
            packet={packet}
            detail={detail}
            onOpenDiff={markOpened}
          />
        ))}
      </div>
      <aside className="flex min-w-[260px] flex-[1_1_272px] flex-col gap-3">
        <MergeDecision detail={detail} packet={packet} opened={opened} />
        <Panel className="gap-1.5" data-testid="merge-footer">
          <h2 className="m-0 font-semibold text-[13px]">Merge</h2>
          <p className="m-0 text-ink-3 leading-normal">
            Merge always needs a person: the factory never merges on its own. The GitHub App merges
            the PR with a merge commit once you decide.
          </p>
          <p className="m-0 text-ink-3">
            Approver: {approverNames.join(", ") || "nobody"} ({detail.approvers.rule})
          </p>
          {item.prUrl && (
            <a
              href={`${item.prUrl}/files`}
              className="w-fit underline"
              onClick={external(`${item.prUrl}/files`, markOpened)}
            >
              Open the diff on GitHub
            </a>
          )}
          {!detail.gates.some((g) => g.kind === "merge" && g.status === "pending") && (
            <p className="m-0 font-medium">{gateOutcome(detail)}</p>
          )}
        </Panel>
      </aside>
    </div>
  );
}

/** A GitHub link: the webview can't open it, so the default browser does; it also marks the diff opened. */
function external(url: string, mark: () => void) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    mark();
    openExternal(url);
  };
}

function gateOutcome(detail: WorkItemDetail): string {
  const last = [...detail.gates].reverse().find((g) => g.kind === "merge");
  if (!last) return "Not at the merge gate yet";
  if (last.decision === "approved") return "Merged";
  if (last.decision === "sent_back") return "Sent back";
  return last.status === "pending" ? "Ready to merge" : capitalise(last.decision ?? last.status);
}

const capitalise = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

function VerdictNotes({ packet }: { packet: ParsedPacket }) {
  const { reasons, warnings } = packetExtras(packet);
  if (reasons.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="verdict-reasons">
      {reasons.map((r) => (
        <li key={r} className="flex items-start gap-2">
          <StatusDot status="failed" className="mt-1.5" />
          {r}
        </li>
      ))}
      {warnings.map((w) => (
        <li key={w} className="flex items-start gap-2">
          <StatusDot status="waiting" className="mt-1.5" />
          {w}
        </li>
      ))}
    </ul>
  );
}

/** The checks the verify run reported (its own words as the detail), and CI on the head SHA. */
function ChecksTable({ packet }: { packet: ParsedPacket }) {
  const { ci } = packetExtras(packet);
  const rows = [
    ...packet.checks.map((c) => ({
      name: c.name,
      where: c.detail ? `Verify run · ${c.detail}` : "Verify run",
      ok: c.status === "pass",
      result: c.status === "pass" ? "Passed" : c.status === "fail" ? "Failed" : "Skipped",
    })),
    ...(ci?.checks ?? [])
      .filter((c) => !packet.checks.some((p) => p.name === c.name))
      .map((c) => ({
        name: c.name,
        where: "GitHub",
        ok: c.conclusion === "success",
        result: c.conclusion === "success" ? "Passed" : (c.conclusion ?? c.status),
      })),
  ];
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle note={`On ${packet.headSha.slice(0, 7)}.`}>Checks</SectionTitle>
      <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel">
        <table className="w-full" data-testid="checks">
          <thead>
            <tr className="text-left text-ink-muted text-xs">
              <th className="px-3 py-2.5 font-medium">Check</th>
              <th className="px-3 py-2.5 font-medium">Reported by</th>
              <th className="px-3 py-2.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-line-soft border-t">
                <td className="px-3 py-2.5 font-mono text-[12.5px]">{r.name}</td>
                <td className="px-3 py-2.5">{r.where}</td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={r.ok ? "done" : "failed"} />
                    {r.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

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
    case "criteria":
      return null;
    case "whatChanged":
      return (
        <Block title="What changed" testId="section-whatChanged">
          {packet.summary ? (
            <div className="[&_code]:font-mono [&_code]:text-xs [&_p]:my-1">
              <Markdown>{packet.summary}</Markdown>
            </div>
          ) : (
            <Empty>No summary.</Empty>
          )}
          <ChangedFiles packet={packet} />
        </Block>
      );
    case "holdout": {
      const holdout = packet.sections.holdout ?? packet.sections.holdouts;
      return (
        <Block
          title="Holdout tests"
          note="Written from the approved criteria, never shown to the build"
          testId="section-holdout"
        >
          {Array.isArray(holdout) && holdout.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
        </Block>
      );
    }
    case "reviewer":
      return (
        <Block
          title="Reviewer notes"
          note={
            packet.reviewer
              ? `Independent review · role ${packet.reviewer.role}${packet.reviewer.model ? ` (${packet.reviewer.model})` : ""}`
              : undefined
          }
          testId="section-reviewer"
        >
          {packet.reviewer ? (
            <div className="flex flex-col gap-2">
              {packet.reviewer.sameModelAsImplementer ? (
                <div className="flex items-center gap-2 text-xs" data-testid="same-model-warning">
                  <StatusDot status="waiting" />
                  The reviewer ran on the same model as the implementer: it is less independent.
                </div>
              ) : (
                <div className="text-ink-muted text-xs">
                  A different model from the implementer.
                </div>
              )}
              <div className="flex items-center gap-2 font-medium">
                <StatusDot status={packet.reviewer.verdict === "approve" ? "done" : "failed"} />
                {packet.reviewer.verdict === "approve" ? "Approve" : "Request changes"}
              </div>
              <div className="whitespace-pre-wrap">{packet.reviewer.notes || "No notes."}</div>
            </div>
          ) : (
            <Empty>No reviewer verdict.</Empty>
          )}
        </Block>
      );
    case "visual": {
      const shots = packet.sections.visual ?? packet.sections.screenshots;
      return (
        <Block
          title="Visual evidence"
          note="Captured by the runner's browser"
          testId="section-visual"
        >
          {Array.isArray(shots) && shots.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {shots.map((s, i) => {
                const label =
                  typeof s === "string"
                    ? s
                    : ((s as { label?: string; ref?: string }).label ?? JSON.stringify(s));
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stored list, never reordered.
                  <li key={i}>{label}</li>
                );
              })}
            </ul>
          ) : (
            <Empty>No screenshots in this packet.</Empty>
          )}
        </Block>
      );
    }
    case "risk":
      return (
        <Block title="Risk flags" testId="section-risk">
          {packet.riskFlags.length ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
        </Block>
      );
    case "diff": {
      const diff = packet.sections.diff;
      return (
        <Collapsible
          onOpenChange={(o) => (o ? onOpenDiff() : undefined)}
          data-testid="section-diff"
        >
          <Panel>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-left font-semibold">
              <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              Diff
            </CollapsibleTrigger>
            <CollapsibleContent>
              {typeof diff === "string" && diff ? (
                <pre className="mt-2 max-h-[480px] overflow-auto rounded-md bg-selected p-3 font-mono text-xs">
                  {diff}
                </pre>
              ) : (
                <div className="mt-1 text-ink-muted">
                  The packet doesn't carry the diff.{" "}
                  {detail.item.prUrl ? (
                    <a
                      href={`${detail.item.prUrl}/files`}
                      className="underline"
                      onClick={external(`${detail.item.prUrl}/files`, onOpenDiff)}
                    >
                      Open it on GitHub
                    </a>
                  ) : (
                    "There is no PR yet."
                  )}
                </div>
              )}
            </CollapsibleContent>
          </Panel>
        </Collapsible>
      );
    }
  }
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
    <Block
      title="Tests intact"
      note="Checked by the factory from the diff on GitHub, not by an agent"
      testId="section-testsIntact"
    >
      {currentHead && currentHead !== packet.headSha && (
        <div className="flex items-start gap-2 text-xs" data-testid="tests-intact-stale">
          <StatusDot status="waiting" className="mt-1" />
          <span>
            This was checked on <span className="font-mono">{sha}</span>, but the branch is now at{" "}
            <span className="font-mono">{currentHead.slice(0, 7)}</span>, which hasn't been checked
            yet.
          </span>
        </div>
      )}
      {!t ? (
        <Empty>Not checked: this packet is from before the guard.</Empty>
      ) : t.intact ? (
        <div className="flex flex-col gap-1" data-testid="tests-intact">
          <div className="flex items-start gap-2">
            <StatusDot status="done" className="mt-1.5" />
            <span>
              No findings on <span className="font-mono">{sha}</span>: no test deleted, removed,
              skipped or commented out, no suppression added, no threshold lowered, no gate file
              changed.
            </span>
          </div>
          <div className="text-ink-muted text-xs">
            This checks the diff's shape only. It can't see a test weakened from inside, such as
            <code className="font-mono"> expect(true)</code>, an emptied body or{" "}
            <code className="font-mono">if (false)</code>.
          </div>
        </div>
      ) : (
        <>
          <div className="text-ink-muted text-xs">
            {total} finding{total === 1 ? "" : "s"} on <span className="font-mono">{sha}</span>
            {total > t.findings.length ? ` (the first ${t.findings.length} are listed)` : ""}. They
            don't fail verify; you decide whether each is right. The factory never merges this on
            its own.
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="test-findings">
            {t.findings.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stored list, never reordered.
              <li key={i} className="flex items-start gap-2">
                <StatusDot status="waiting" className="mt-1.5" />
                <div className="min-w-0">
                  {/* The message is Markdown for factory/verify; here its backticks are noise. */}
                  <div>{f.message.replaceAll("`", "")}</div>
                  {f.path && (
                    <div className="font-mono text-ink-muted text-xs">
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
    </Block>
  );
}

function Block({
  title,
  note,
  testId,
  children,
}: {
  title: string;
  note?: string | undefined;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <SectionTitle {...(note ? { note } : {})}>{title}</SectionTitle>
      <Panel>{children}</Panel>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-ink-muted">{children}</div>;
}

function ChangedFiles({ packet }: { packet: ParsedPacket }) {
  const { changed } = packetExtras(packet);
  if (!changed || changed.files === null) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-ink-muted">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        {changed.files} {changed.files === 1 ? "file" : "files"} changed
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 font-mono text-xs">
          {changed.paths.map((f) => (
            <li key={f.path}>
              <span className="text-ink-muted">{f.status.padEnd(9, " ")}</span> {f.path}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
