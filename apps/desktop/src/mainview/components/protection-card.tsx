// "Protection on `main` changed" (ADR 0280; ported from sf-app for spec 40 M3): a project's
// default-branch protection was green and is now red (a ruleset edited or deleted on GitHub, seen by
// a webhook or the daily re-check). Same buttons as Setup: download the ruleset, open GitHub's
// rulesets page, then Check now in Setup. The webview can't download, so the ruleset is read with
// `protection.ruleset` and saved to ~/Downloads through the main process.

import { ago, errorMessage } from "@software-factory/client/format";
import type { Inbox } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, saveFile } from "../lib/external.tsx";
import { read } from "../lib/op.ts";

type Drift = Inbox["protection"][number];
type RulesetFile = Drift["files"][number];

export function ProtectionChangedCard({ drift }: { drift: Drift }) {
  const [saving, setSaving] = useState<string | null>(null);
  async function download(f: RulesetFile) {
    setSaving(f.kind);
    try {
      const file = await read("protection.ruleset", { projectId: drift.projectId, kind: f.kind });
      if (await saveFile(file.filename, file.json))
        toast.success(`Saved ${file.filename} to Downloads`);
      else toast.error(`Couldn't save ${file.filename}`);
    } catch (error) {
      toast.error(`Couldn't download the ruleset: ${errorMessage(error)}`);
    } finally {
      setSaving(null);
    }
  }
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
          <Button
            key={f.kind}
            size="sm"
            disabled={saving !== null}
            onClick={() => void download(f)}
          >
            Download {f.kind === "default-branch" ? "ruleset" : "factory/* ruleset"}
          </Button>
        ))}
        <Button size="sm" variant="outline" asChild>
          <ExternalLink href={drift.rulesetsUrl}>Open GitHub rulesets ↗</ExternalLink>
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
