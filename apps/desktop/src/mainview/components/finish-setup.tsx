// The inbox's "Finish setup" card (ADR 0055; ported from sf-app for spec 40 M3): shown until every
// Setup step is green, with the first step that isn't.
import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { setupStatusQuery } from "../lib/queries.ts";
import { PageHeader, Panel } from "./shell-list.tsx";

export function FinishSetupCard({ orgId }: { orgId: string }) {
  const status = useQuery({ ...setupStatusQuery(orgId), enabled: !!orgId });
  if (!status.data || status.data.complete) return null;
  const steps = status.data.steps;
  const next = steps.find((s) => !s.done);
  const done = steps.filter((s) => s.done).length;
  return (
    <div className="flex flex-col gap-4" data-testid="finish-setup">
      <PageHeader
        above="Notice"
        title="Finish setup"
        sub={`${done} of ${steps.length} done. The factory takes no work until the first four are green.`}
        testId="inbox-title"
      />
      <Panel className="gap-0 p-0">
        {steps.map((s) => (
          <div
            key={s.key}
            className="flex items-center gap-3 border-line-soft border-t px-3.5 py-3 first:border-t-0"
          >
            <StatusDot status={s.done ? "done" : "waiting"} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{LABEL[s.key]}</div>
              <div className="text-ink-3 text-xs">{s.detail}</div>
            </div>
          </div>
        ))}
      </Panel>
      {next && (
        <Button asChild className="w-fit">
          <Link to="/setup">Open Setup</Link>
        </Button>
      )}
    </div>
  );
}

const LABEL: Record<string, string> = {
  github: "GitHub",
  project: "Project",
  policy: "Policy",
  runner: "Runner online",
  protect: "Protect main",
};
