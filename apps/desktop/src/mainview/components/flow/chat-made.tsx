// What a chat made (spec 70, "Chat"), beside the conversation: the items and projects the model
// created there, and the workflows, plugins, agents and gateways it created or changed, grouped, each
// opening where it lives. The pane shows only once the chat has made something, so a plain
// conversation is just a conversation. When the model does something, what it shows is read again.
import { didCount, type FlowChatView, type FlowMade } from "@software-factory/client/flow-chat";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  FileTextIcon,
  FolderIcon,
  PlugIcon,
  PuzzleIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect } from "react";
import { flowPluginsQuery } from "../../lib/flow-edit-queries.ts";
import { flowProjectsQuery, flowWorkflowQuery } from "../../lib/flow-queries.ts";
import { itemRef } from "./chat-steps.tsx";

function Group({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5" data-testid={testId}>
      <h4 className="mb-2 font-semibold text-[11px] text-ink-faint uppercase tracking-[.03em]">
        {title}
      </h4>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function Row({
  icon,
  lead,
  name,
  sub,
  onOpen,
  testId,
}: {
  icon: React.ReactNode;
  lead?: string | null;
  name: string;
  sub?: string | null;
  onOpen: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 items-start gap-2 rounded-[9px] border border-line bg-panel px-3 py-2 text-left hover:border-line-strong"
      data-testid={testId}
    >
      <span className="mt-0.5 flex-none text-ink-muted [&_svg]:size-3.5">{icon}</span>
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          {lead && <span className="flex-none text-[12px] text-ink-muted">{lead}</span>}
          <span className="truncate">{name}</span>
        </span>
        {sub && <span className="truncate text-[12px] text-ink-muted">{sub}</span>}
      </span>
    </button>
  );
}

export function MadePane({ orgId, view }: { orgId: string; view: FlowChatView }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const projects = useQuery(flowProjectsQuery(orgId));
  const plugins = useQuery(flowPluginsQuery(orgId));
  const made = view.made;
  const workflows = useQueries({
    queries: made.workflows.map((w) => flowWorkflowQuery(orgId, w.id)),
  });
  const dids = didCount(view.messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read only when a did row arrives
  useEffect(() => {
    if (dids === 0) return;
    for (const key of [["workflow"], ["workflows"], ["plugins"], ["projects"], ["agents"]]) {
      void client.invalidateQueries({ queryKey: ["flow", orgId, ...key] });
    }
  }, [dids]);

  const openWorkflow = (workflowId: string) => {
    const project = projects.data?.projects.find((p) => p.workflowId === workflowId);
    if (project)
      void navigate({
        to: "/flow/$orgId/p/$projectId",
        params: { orgId, projectId: project.id },
        search: { view: "workflow" },
      });
    else
      void navigate({
        to: "/flow/$orgId/workflows",
        params: { orgId },
        search: { workflow: workflowId },
      });
  };
  const list = (things: FlowMade[]) => things.length > 0;

  return (
    <aside
      className="w-[340px] flex-none overflow-auto border-line-soft border-l bg-board px-4 py-4 max-[1100px]:w-[290px]"
      data-testid="chat-made"
    >
      {list(made.items) && (
        <Group title="Items" testId="made-items">
          {made.items.map((i) => (
            <Row
              key={i.id}
              icon={<FileTextIcon />}
              lead={itemRef(projects.data?.projects, i.projectId, i.number)}
              name={i.name}
              onOpen={() =>
                i.projectId &&
                void navigate({
                  to: "/flow/$orgId/p/$projectId",
                  params: { orgId, projectId: i.projectId },
                  search: { item: i.id },
                })
              }
              testId="made-item"
            />
          ))}
        </Group>
      )}
      {list(made.projects) && (
        <Group title="Projects" testId="made-projects">
          {made.projects.map((p) => (
            <Row
              key={p.id}
              icon={<FolderIcon />}
              name={projects.data?.projects.find((x) => x.id === p.id)?.name ?? p.name}
              onOpen={() =>
                void navigate({
                  to: "/flow/$orgId/p/$projectId",
                  params: { orgId, projectId: p.id },
                })
              }
              testId="made-project"
            />
          ))}
        </Group>
      )}
      {list(made.workflows) && (
        <Group title="Workflows" testId="made-workflows">
          {made.workflows.map((w, n) => {
            const read = workflows[n]?.data?.workflow;
            return (
              <Row
                key={w.id}
                icon={<WorkflowIcon />}
                name={read?.name ?? w.name}
                sub={read ? read.statuses.map((s) => s.name).join(" → ") : null}
                onOpen={() => openWorkflow(w.id)}
                testId="made-workflow"
              />
            );
          })}
        </Group>
      )}
      {list(made.plugins) && (
        <Group title="Plugins" testId="made-plugins">
          {made.plugins.map((p) => {
            const found = plugins.data?.plugins.find((x) => x.id === p.id);
            return (
              <Row
                key={p.id}
                icon={<PuzzleIcon />}
                name={found?.name ?? p.name}
                sub={found?.request ? `“${found.request}”` : null}
                onOpen={() => void navigate({ to: "/flow/$orgId/plugins", params: { orgId } })}
                testId="made-plugin"
              />
            );
          })}
        </Group>
      )}
      {list(made.agents) && (
        <Group title="Agents" testId="made-agents">
          {made.agents.map((a) => (
            <Row
              key={a.id}
              icon={<BotIcon />}
              name={a.name}
              onOpen={() =>
                void navigate({
                  to: "/flow/$orgId/team",
                  params: { orgId },
                  search: { agent: a.id },
                })
              }
              testId="made-agent"
            />
          ))}
        </Group>
      )}
      {list(made.gateways) && (
        <Group title="Gateways" testId="made-gateways">
          {made.gateways.map((g) => (
            <Row
              key={g.id}
              icon={<PlugIcon />}
              name={g.name}
              onOpen={() =>
                void navigate({
                  to: "/flow/$orgId/plugins",
                  params: { orgId },
                  search: { tab: "gateways" },
                })
              }
              testId="made-gateway"
            />
          ))}
        </Group>
      )}
      <p className="mt-1 text-[12px] text-ink-muted">
        Made in this chat. Changes are live at once.
      </p>
    </aside>
  );
}
