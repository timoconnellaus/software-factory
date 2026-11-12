// "Protection on `main` changed" (ADR 0280): a project's default-branch protection was green and is
// now red (a ruleset edited or deleted on GitHub, seen by a webhook or the daily re-check). Same
// buttons as Setup: download the ruleset, open GitHub's rulesets page, then Check now in Setup.

import { ago } from "@software-factory/client/format";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Link } from "@tanstack/react-router";
import type { Inbox } from "#/lib/ops";
import { rulesetDownloadPath } from "#/lib/ruleset";

type Drift = Inbox["protection"][number];

export function ProtectionChangedCard({ drift }: { drift: Drift }) {
  return (
    <Card className="gap-2 px-5 py-4" data-testid={`protection-changed-${drift.projectId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot status="failed" />
        <span className="font-semibold">
          Protection on <code className="font-mono">{drift.branch}</code> changed
        </span>
        <span className="text-muted-foreground text-xs">
          {drift.repo.owner}/{drift.repo.name} · {ago(drift.changedAt)}
        </span>
      </div>
      <ul className="grid list-disc gap-0.5 pl-5 text-sm">
        {drift.problems.map((p) => (
          <li key={p}>{p.replace(/`/g, "")}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {drift.files.map((f) => (
          <Button key={f.kind} size="sm" asChild>
            <a href={rulesetDownloadPath(drift.projectId, f.kind)} download={f.filename}>
              Download {f.kind === "default-branch" ? "ruleset" : "factory/* ruleset"}
            </a>
          </Button>
        ))}
        <Button size="sm" variant="outline" asChild>
          <a href={drift.rulesetsUrl} target="_blank" rel="noreferrer">
            Open GitHub rulesets ↗
          </a>
        </Button>
        <Link to="/setup" search={{}} className="text-sm underline">
          Check now in Setup
        </Link>
      </div>
      <div className="text-muted-foreground text-xs">
        On GitHub: New ruleset → Import a ruleset → choose the file → Create.
      </div>
    </Card>
  );
}
