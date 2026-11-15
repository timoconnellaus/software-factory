// Auto's Triggers tab: read-only. Each plugin that defines a trigger, with the URL an outside system
// posts to (a JSON body) and a button to copy it. The URL carries the plugin's key, so it is shown
// only to the org's members. Triggers are made and changed in Plugins.
import { Button } from "@software-factory/ui/components/button";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyIcon, PuzzleIcon } from "lucide-react";
import { toast } from "sonner";
import { useDesktopSession } from "../../lib/desktop-session.ts";
import { flowPluginsQuery } from "../../lib/flow-edit-queries.ts";
import { Pill } from "./parts.tsx";

/** The full URL: the engine this app talks to, then the plugin's trigger path. */
export const triggerUrl = (engineUrl: string | undefined, path: string) =>
  `${(engineUrl ?? "").replace(/\/+$/, "")}${path}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Trigger URL copied");
  } catch {
    toast.error("Couldn't copy the URL");
  }
}

export function Triggers({ orgId }: { orgId: string }) {
  const plugins = useQuery(flowPluginsQuery(orgId));
  const desktop = useDesktopSession();
  const withTrigger = (plugins.data?.plugins ?? []).filter((p) => p.triggerPath);
  const pluginsLink = (
    <Link
      to="/flow/$orgId/plugins"
      params={{ orgId }}
      className="text-ink underline underline-offset-2"
    >
      Plugins
    </Link>
  );
  if (plugins.error)
    return <p className="text-bad">Couldn't load the plugins. {plugins.error.message}</p>;
  if (!plugins.data) return <Skeleton className="h-20 w-full max-w-[860px]" />;
  return (
    <div className="grid max-w-[860px] gap-3">
      {withTrigger.length > 0 && (
        <ul
          className="overflow-hidden rounded-[10px] border border-line bg-panel"
          data-testid="trigger-list"
        >
          {withTrigger.map((p) => {
            const url = triggerUrl(desktop?.engineUrl, p.triggerPath ?? "");
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 border-line-soft border-b px-3.5 py-2.5 last:border-b-0"
                data-testid="trigger-row"
              >
                <PuzzleIcon className="size-4 flex-none text-ink-muted" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-medium">
                    {p.name}
                    {!p.enabled && <Pill>Off</Pill>}
                  </span>
                  <code
                    className="block truncate font-mono text-[12px] text-ink-muted"
                    title={url}
                    data-testid="trigger-url"
                  >
                    {url}
                  </code>
                </span>
                <Button
                  size="md"
                  variant="ghost"
                  onClick={() => void copy(url)}
                  data-testid="copy-trigger"
                >
                  <CopyIcon />
                  Copy
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[12.5px] text-ink-muted" data-testid="triggers-note">
        {withTrigger.length > 0 ? (
          <>
            An outside system starts one by posting JSON to its URL; put the trigger's name in place
            of <code className="font-mono">&lt;name&gt;</code>. The URL holds a key: share it only
            with the system that calls it. Triggers come from plugins, in {pluginsLink}.
          </>
        ) : (
          <>
            Triggers come from plugins: a plugin can start work when an outside system calls it.
            None of yours has one yet. See them in {pluginsLink}.
          </>
        )}
      </p>
    </div>
  );
}
