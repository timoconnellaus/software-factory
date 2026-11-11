// The inbox's "Finish setup" card (ADR 0055): shown until every Setup step is green, with the
// first step that isn't.
import { Card } from "@software-factory/ui/components/card";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { setupStatusQuery } from "#/lib/queries";

export function FinishSetupCard({ orgId }: { orgId: string }) {
  const status = useQuery({ ...setupStatusQuery(orgId), enabled: !!orgId });
  if (!status.data || status.data.complete) return null;
  const steps = status.data.steps;
  const next = steps.find((s) => !s.done);
  const done = steps.filter((s) => s.done).length;
  return (
    <Card className="gap-2 px-5 py-4" data-testid="finish-setup">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Finish setup</span>
        <span className="text-muted-foreground text-xs">
          {done} of {steps.length} done
        </span>
        <span className="grow" />
        <Link to="/setup" search={{}} className="text-sm underline">
          Open Setup
        </Link>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {steps.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <StatusDot status={s.done ? "done" : "waiting"} />
            {LABEL[s.key]}
          </span>
        ))}
      </div>
      {next && <div className="text-muted-foreground text-sm">Next: {next.detail}</div>}
    </Card>
  );
}

const LABEL: Record<string, string> = {
  github: "GitHub",
  project: "Project",
  policy: "Policy",
  runner: "Runner online",
  verify: "factory/verify",
};
