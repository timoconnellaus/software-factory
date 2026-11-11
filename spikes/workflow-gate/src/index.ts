// The spike's Worker: the inbox (HTML), a JSON intake endpoint, and the outbox retry cron.
// No auth: every inbox action runs as the local human. The real app uses Better Auth (plan).
import type { Actor } from "./ops/define";
import { describeOperations } from "./ops/define";
import { isOperationError } from "./ops/errors";
import { invoke } from "./ops/invoke";
import "./ops/operations";
import { listPending, renderInbox } from "./inbox";
import { retryOutbox } from "./ops/outbox";

export { WorkItemWorkflow } from "./workflow";

const HUMAN: Actor = { type: "human", id: "local" };
const INTAKE_API: Actor = { type: "intake", id: "api" };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (request.method === "GET" && pathname === "/") {
        return html(await renderInbox(env.DB, url.searchParams.get("flash") ?? undefined));
      }
      if (request.method === "GET" && pathname === "/api/pending") {
        return Response.json(await listPending(env.DB));
      }
      if (request.method === "GET" && pathname === "/api/operations") {
        return Response.json(describeOperations());
      }
      // JSON intake (a gatekeeper would call this after verifying a webhook signature).
      if (request.method === "POST" && pathname === "/api/intake") {
        const result = await invoke(env, "workItem.intake", await request.json(), {
          actor: INTAKE_API,
          origin: { surface: "api" },
        });
        return Response.json(result);
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const field = (name: string) => {
          const value = form.get(name);
          return typeof value === "string" ? value : undefined;
        };
        const origin = { surface: "inbox" as const };
        if (pathname === "/intake") {
          await invoke(
            env,
            "workItem.intake",
            {
              source: "inbox",
              externalId: crypto.randomUUID(),
              title: field("title"),
              size: field("size"),
            },
            { actor: HUMAN, origin },
          );
          return redirect("Added.");
        }
        const approval = pathname.match(/^\/approvals\/([A-Za-z0-9_]+)$/);
        if (approval) {
          const note = field("note");
          await invoke(
            env,
            "approval.decide",
            {
              pendingActionId: approval[1],
              decision: field("decision"),
              ...(note ? { note } : {}),
            },
            { actor: HUMAN, origin },
          );
          return redirect(`${field("decision") === "approved" ? "Approved" : "Rejected"}.`);
        }
        if (pathname === "/kill-switch") {
          await invoke(
            env,
            "factory.setKillSwitch",
            { on: field("on") === "1" },
            { actor: HUMAN, origin },
          );
          return redirect(field("on") === "1" ? "Kill switch on." : "Kill switch off.");
        }
        if (pathname === "/preset") {
          await invoke(
            env,
            "policy.setPreset",
            { preset: field("preset") },
            { actor: HUMAN, origin },
          );
          return redirect("Preset saved.");
        }
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (isOperationError(error)) {
        const status =
          { not_found: 404, conflict: 409, invalid_input: 400 }[error.code as string] ?? 403;
        return Response.json(
          { error: error.code, message: error.message, details: error.details },
          { status },
        );
      }
      throw error;
    }
  },

  async scheduled(_controller, env): Promise<void> {
    await retryOutbox(env);
  },
} satisfies ExportedHandler<Env>;

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (flash: string) =>
  new Response(null, {
    status: 303,
    headers: { location: `/?flash=${encodeURIComponent(flash)}` },
  });
