// The `sf` commands (spec 07). `main` takes its environment, fetch and output as arguments, so the
// whole CLI runs in tests against a fake engine; src/cli.ts wires the real ones.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { describeEntry } from "@software-factory/timeline";
import { type Api, httpApi, type OperationInfo, result } from "./api.ts";
import {
  type CliConfig,
  clearToken,
  configFile,
  loadConfig,
  type Settings,
  saveConfig,
  settings,
} from "./config.ts";
import { deviceLogin } from "./device-login.ts";
import { CliError, usage } from "./errors.ts";
import { ago, oneLine, ordinal, short, status, table } from "./format.ts";
import {
  listProjects,
  orgIds,
  resolveProject,
  resolveWorkItem,
  type Scope,
  WORK_ITEM_ID,
} from "./resolve.ts";
import type {
  Created,
  Inbox,
  ItemSummary,
  Project,
  QueueEntry,
  TimelineEntry,
  WorkItemDetail,
} from "./types.ts";

export interface Io {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Opens a link in the browser; null where there's no `open` (anywhere but macOS). */
  open: ((url: string) => void) | null;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Ctx {
  io: Io;
  file: string;
  config: CliConfig;
  settings: Settings;
  api: Api;
  scope: Scope;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface Command {
  usage: string;
  summary: string;
  options?: ParseArgsOptionsConfig;
  run(ctx: Ctx, values: Values, args: string[]): Promise<number | undefined>;
}

const COMMON: ParseArgsOptionsConfig = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  org: { type: "string" },
};

const LIVE = ["running", "waiting", "paused"];

const str = (v: Values[string]) => (typeof v === "string" ? v : undefined);

function printJson(ctx: Ctx, value: unknown) {
  ctx.io.out(JSON.stringify(value, null, 2));
}

/** The app's page for a work item, or its review packet. */
function workLink(ctx: Ctx, workItemId: string, review = false) {
  return `${ctx.settings.appUrl}/work/${workItemId}${review ? "/review" : ""}`;
}

/** Where a gate is decided: the merge gate on the review packet, the rest on the item's page. */
function gateLink(ctx: Ctx, kind: string, workItemId: string | null) {
  if (!workItemId) return ctx.settings.appUrl;
  return workLink(ctx, workItemId, kind === "merge");
}

async function readInput(ctx: Ctx, arg: string | undefined): Promise<unknown> {
  if (arg === undefined) return {};
  let text: string;
  if (arg === "-") text = await ctx.io.readStdin();
  else if (arg.startsWith("@")) text = await ctx.io.readFile(arg.slice(1));
  else text = arg;
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw usage(`the input isn't JSON: ${oneLine(text, 60)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

const login: Command = {
  usage: "sf login [--write] [--name <name>] [--url <engine>] [--app-url <app>] [--no-open]",
  summary: "Log in by device code (a read token unless --write; you pick the scope in the app)",
  options: {
    write: { type: "boolean" },
    name: { type: "string" },
    url: { type: "string" },
    "app-url": { type: "string" },
    "no-open": { type: "boolean" },
  },
  async run(ctx, values) {
    const url = (str(values.url) ?? ctx.settings.url).replace(/\/+$/, "");
    const appUrl = (str(values["app-url"]) ?? ctx.settings.appUrl).replace(/\/+$/, "");
    const asked = values.write ? "write" : "read";
    const open = values["no-open"] ? null : ctx.io.open;
    const got = await deviceLogin({
      baseUrl: url,
      appUrl,
      name: str(values.name) ?? `sf on ${hostname()}`,
      scope: asked,
      fetch: ctx.io.fetch,
      now: ctx.io.now,
      print: ctx.io.out,
      ...(ctx.io.sleep ? { sleep: ctx.io.sleep } : {}),
      ...(open ? { open } : {}),
    });
    await saveConfig(ctx.file, {
      url,
      appUrl,
      token: got.token,
      tokenId: got.tokenId,
      scope: got.scope,
      login: got.login,
      expiresAt: got.expiresAt,
    });
    ctx.io.out("");
    ctx.io.out(
      `Logged in${got.login ? ` as ${got.login}` : ""} with a ${got.scope} token${got.expiresAt ? `, until ${got.expiresAt.slice(0, 10)}` : ""}.`,
    );
    if (got.scope !== asked) ctx.io.out(`You asked for ${asked}; the app granted ${got.scope}.`);
    ctx.io.out(`Saved to ${ctx.file}.`);
    if (ctx.settings.tokenSource === "env") {
      ctx.io.err("Note: SF_TOKEN is set in this shell and is used instead of this login.");
    }
    return 0;
  },
};

const logout: Command = {
  usage: "sf logout",
  summary: "Revoke the stored token and delete it",
  async run(ctx) {
    const { token, tokenId } = ctx.config;
    if (!token) {
      ctx.io.out("Not logged in: there's no stored token.");
      if (ctx.settings.tokenSource === "env") ctx.io.out("(SF_TOKEN is set; unset it yourself.)");
      return 0;
    }
    let failed: CliError | Error | null = null;
    if (tokenId) {
      // The stored token revokes itself, whatever SF_TOKEN says.
      const own = httpApi({ url: ctx.settings.url, token, fetch: ctx.io.fetch });
      try {
        await result(own, "cliToken.revoke", { tokenId });
      } catch (err) {
        failed = err instanceof Error ? err : new Error(String(err));
      }
    } else {
      failed = new Error("the config has no tokenId to revoke");
    }
    await clearToken(ctx.file, ctx.config);
    if (failed) {
      const why = failed instanceof CliError ? `${failed.code}: ${failed.message}` : failed.message;
      ctx.io.err(`Couldn't revoke the token on the factory (${why}).`);
      ctx.io.err(
        `Deleted it here anyway. It still works until it expires${ctx.config.expiresAt ? ` (${ctx.config.expiresAt.slice(0, 10)})` : ""}, unless revoked with \`sf tokens revoke ${tokenId ?? "<id>"}\` from another login.`,
      );
      return 1;
    }
    ctx.io.out("Revoked the token and deleted it.");
    return 0;
  },
};

const statusCommand: Command = {
  usage: "sf status [--json]",
  summary: "Where the CLI points, who it's logged in as, the scope and expiry",
  async run(ctx, values) {
    const { config, settings: s } = ctx;
    const expired = config.expiresAt ? Date.parse(config.expiresAt) <= ctx.io.now() : false;
    const view = {
      url: s.url,
      appUrl: s.appUrl,
      token: s.tokenSource === "env" ? "SF_TOKEN" : s.tokenSource === "config" ? ctx.file : null,
      login: config.login ?? null,
      scope: config.scope ?? null,
      expiresAt: config.expiresAt ?? null,
      expired,
    };
    if (values.json) {
      printJson(ctx, view);
      return s.token ? 0 : 1;
    }
    const rows = [
      ["engine", s.url],
      ["app", s.appUrl],
      ["token", view.token ?? "none: run `sf login`"],
    ];
    if (config.token) {
      rows.push(
        ["login", config.login ?? "?"],
        ["scope", config.scope ?? "?"],
        [
          "expires",
          config.expiresAt
            ? `${config.expiresAt}${expired ? " (expired: run `sf login`)" : ""}`
            : "?",
        ],
      );
    }
    for (const line of table(rows)) ctx.io.out(line);
    if (s.tokenSource === "env" && config.token) {
      ctx.io.out("(SF_TOKEN overrides the stored login above.)");
    }
    return s.token ? 0 : 1;
  },
};

const ops: Command = {
  usage: "sf ops [--json]",
  summary: "The operations, with their risk; browser-only ones are decided in the app",
  async run(ctx, values) {
    const list = await ctx.api.ops();
    if (values.json) {
      printJson(ctx, { operations: list });
      return 0;
    }
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    for (const line of table(
      sorted.map((o) => [
        o.name,
        o.risk,
        o.browserOnly === true ? "browser-only" : o.browserOnly ? "browser-only (some inputs)" : "",
        oneLine(o.description.split(/(?<=\.)\s/)[0] ?? "", 70),
      ]),
    )) {
      ctx.io.out(line);
    }
    return 0;
  },
};

const call: Command = {
  usage: "sf call <op> [<input-json> | @file | -]",
  summary: "Call any operation your token's scope allows; prints its result as JSON",
  async run(ctx, _values, args) {
    const [op, arg, ...extra] = args;
    if (!op) throw usage("which operation? `sf ops` lists them");
    if (extra.length) throw usage("pass the input as one JSON argument (quote it), @file or -");
    const input = await readInput(ctx, arg);
    const outcome = await ctx.api.call(op, input);
    if (outcome.kind === "pending") {
      printJson(ctx, { pending: true, pendingActionId: outcome.pendingActionId });
      ctx.io.err("This opened a gate: a person decides it in the app.");
      return 0;
    }
    printJson(ctx, outcome.result);
    return 0;
  },
};

const inbox: Command = {
  usage: "sf inbox [--org <id>] [--json]",
  summary: "What's waiting on you: gates, questions, running items, runners",
  async run(ctx, values) {
    const view = await result<Inbox>(
      ctx.api,
      "inbox.list",
      ctx.scope.org ? { orgId: ctx.scope.org } : {},
    );
    if (values.json) {
      printJson(ctx, view);
      return 0;
    }
    const numbers = new Map(view.running.map((i) => [i.id, `#${i.number}`]));
    const now = ctx.io.now();
    const section = (title: string, rows: string[][]) => {
      if (!rows.length) return;
      ctx.io.out(title);
      for (const line of table(rows)) ctx.io.out(`  ${line}`);
    };
    const waiting = [
      ...view.gates.map((g) => [
        `${g.kind} gate${g.escalated ? " (escalated)" : ""}`,
        (g.workItemId && numbers.get(g.workItemId)) ?? "",
        oneLine(g.title, 60),
        ago(g.createdAt, now),
        gateLink(ctx, g.kind, g.workItemId),
      ]),
      ...view.questions.map((q) => [
        `question (${q.domain})`,
        numbers.get(q.workItemId) ?? "",
        oneLine(`${q.title}: ${q.prompt}`, 60),
        "",
        workLink(ctx, q.workItemId),
      ]),
    ];
    section("Waiting on you", waiting);
    section(
      "Running",
      view.running.map((i) => [
        `#${i.number}`,
        i.stage,
        status(i.status, i.statusReason),
        oneLine(i.title, 60),
        ago(i.updatedAt, now),
      ]),
    );
    section(
      "Your runners",
      view.runners.map((r) => [r.name, r.state, `${r.inUse}/${r.max} in use`]),
    );
    section(
      "Held by a WIP limit",
      view.wipHolds.map((h) => [h.projectId, `${h.waitingBuilds} builds waiting on review`]),
    );
    section(
      "Branch protection changed",
      view.protection.map((p) => [
        `${p.name} (${p.branch})`,
        oneLine(p.problems.join("; "), 80),
        p.rulesetsUrl,
      ]),
    );
    if (!waiting.length && !view.running.length) ctx.io.out("Nothing is waiting on you.");
    return 0;
  },
};

const ls: Command = {
  usage: "sf ls [--project <name|id>] [--all] [--limit <n>] [--json]",
  summary: "Work items, newest first (live ones unless --all)",
  options: {
    project: { type: "string", short: "p" },
    all: { type: "boolean", short: "a" },
    limit: { type: "string" },
  },
  async run(ctx, values) {
    const limit = values.limit ? Number(values.limit) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw usage("--limit is 1 to 200");
    const filter = { ...(values.all ? {} : { status: LIVE }), limit };
    let items: ItemSummary[];
    let projectNames = new Map<string, string>();
    if (values.project) {
      const p = await resolveProject(ctx.scope, str(values.project));
      ({ items } = await result<{ items: ItemSummary[] }>(ctx.api, "workItem.list", {
        projectId: p.id,
        ...filter,
      }));
    } else {
      const orgs = await orgIds(ctx.scope);
      const lists = await Promise.all(
        orgs.map((orgId) =>
          result<{ items: ItemSummary[] }>(ctx.api, "workItem.list", { orgId, ...filter }),
        ),
      );
      items = lists.flatMap((l) => l.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (new Set(items.map((i) => i.projectId)).size > 1) {
        const projects = await listProjects(ctx.scope).catch(() => [] as Project[]);
        projectNames = new Map(projects.map((p) => [p.id, p.name]));
        for (const i of items)
          if (!projectNames.has(i.projectId)) projectNames.set(i.projectId, i.projectId);
      }
    }
    if (values.json) {
      printJson(ctx, { items });
      return 0;
    }
    if (!items.length) {
      ctx.io.out(
        values.all ? "No work items." : "Nothing live. `sf ls --all` shows finished work.",
      );
      return 0;
    }
    const now = ctx.io.now();
    for (const line of table(
      items.map((i) => [
        `#${i.number}`,
        ...(projectNames.size ? [projectNames.get(i.projectId) ?? ""] : []),
        i.stage,
        status(i.status, i.statusReason ? oneLine(i.statusReason, 40) : null),
        oneLine(i.title, 60),
        ago(i.updatedAt, now),
      ]),
    )) {
      ctx.io.out(line);
    }
    return 0;
  },
};

const show: Command = {
  usage: "sf show <n|wi_id> [--project <name|id>] [--json]",
  summary: "One work item: stage, status, PR, merge queue place, open gates, runs, review",
  options: { project: { type: "string", short: "p" } },
  async run(ctx, values, args) {
    const id = await resolveWorkItem(ctx.scope, args[0], str(values.project));
    const d = await result<WorkItemDetail>(ctx.api, "workItem.get", { workItemId: id });
    if (values.json) {
      printJson(ctx, d);
      return 0;
    }
    const out = ctx.io.out;
    const now = ctx.io.now();
    const { item } = d;
    out(`#${item.number} ${item.title}`);
    const rows = [
      ["id", item.id],
      ["kind", `${item.kind}${item.size ? ` (${item.size})` : ""}`],
      ["stage", item.stage],
      ["status", status(item.status, item.statusReason)],
    ];
    if (item.prUrl) rows.push(["PR", item.prUrl]);
    if (item.stage === "merge" || d.mergeQueue) {
      rows.push([
        "queue",
        d.mergeQueue
          ? d.mergeQueue.position === 1
            ? "1st in the merge queue: lands next"
            : `${ordinal(d.mergeQueue.position)} in the merge queue, after ${d.mergeQueue.ahead.map((n) => `#${n}`).join(", ")}`
          : "not in the merge queue",
      ]);
    }
    rows.push(["link", workLink(ctx, item.id)]);
    for (const line of table(rows)) out(`  ${line}`);

    const open = d.gates.filter((g) => g.status === "pending");
    const blocking = d.questions.filter((q) => q.status === "open");
    if (open.length || blocking.length) {
      out("");
      out("Open gates (decide them in the app)");
      for (const line of table([
        ...open.map((g) => [
          `${g.kind} gate`,
          g.operation,
          ago(g.createdAt, now),
          gateLink(ctx, g.kind, item.id),
        ]),
        ...blocking.map((q) => [
          `question (${q.domain})`,
          oneLine(q.prompt, 60),
          q.blocking ? "blocking" : "",
          workLink(ctx, item.id),
        ]),
      ])) {
        out(`  ${line}`);
      }
    }
    if (d.runs.length) {
      out("");
      out("Runs");
      for (const line of table(
        d.runs.map((r) => [
          `#${r.runNo}`,
          r.stage,
          r.status,
          r.outcome ?? "",
          ago(r.endedAt ?? r.startedAt, now),
          r.takeover ? `take over: ${r.takeover.label}` : oneLine(r.summary ?? "", 50),
        ]),
      )) {
        out(`  ${line}`);
      }
    }
    if (d.reviewPacket) {
      const p = d.reviewPacket;
      out("");
      out(`Review packet: ${p.verdict} on ${short(p.headSha)}, ${ago(p.createdAt, now)}`);
      if (p.summary) out(`  ${oneLine(p.summary, 96)}`);
      if (p.riskFlags.length) out(`  risk flags: ${p.riskFlags.join(", ")}`);
      out(`  ${workLink(ctx, item.id, true)}`);
    }
    return 0;
  },
};

const timeline: Command = {
  usage: "sf timeline <n|wi_id> [--project <name|id>] [--limit <n>] [--json]",
  summary: "A work item's event log, oldest first, in the dashboard's words",
  options: { project: { type: "string", short: "p" }, limit: { type: "string" } },
  async run(ctx, values, args) {
    const id = await resolveWorkItem(ctx.scope, args[0], str(values.project));
    const input: Record<string, unknown> = { workItemId: id };
    if (values.limit) input.limit = Number(values.limit);
    const { entries } = await result<{ entries: TimelineEntry[] }>(
      ctx.api,
      "workItem.timeline",
      input,
    );
    if (values.json) {
      printJson(ctx, { entries });
      return 0;
    }
    // The web timeline's wording (spec wi-4). The CLI doesn't know the viewer's id or fetch gates,
    // so a person reads as "a person" and a decision's note stays on the web.
    for (const line of table(
      entries.map((e) => {
        const d = describeEntry(e);
        return [
          e.at.slice(0, 19).replace("T", " "),
          d.label,
          d.actor,
          oneLine([d.detail, d.outcome, d.note].filter(Boolean).join(" · "), 100),
        ];
      }),
    )) {
      ctx.io.out(line);
    }
    return 0;
  },
};

const queue: Command = {
  usage: "sf queue [--project <name|id>] [--json]",
  summary: "The merge queue, head first (every project's unless --project)",
  options: { project: { type: "string", short: "p" } },
  async run(ctx, values) {
    const projects: (Pick<Project, "id"> & Partial<Project>)[] = values.project
      ? [await resolveProject(ctx.scope, str(values.project))]
      : await listProjects(ctx.scope);
    const queues = await Promise.all(
      projects.map(async (p) => ({
        project: p,
        entries: (
          await result<{ entries: QueueEntry[] }>(ctx.api, "mergeQueue.list", {
            projectId: p.id,
          })
        ).entries,
      })),
    );
    if (values.json) {
      printJson(
        ctx,
        queues.map((q) => ({ projectId: q.project.id, name: q.project.name, entries: q.entries })),
      );
      return 0;
    }
    const now = ctx.io.now();
    const many = queues.length > 1;
    let any = false;
    for (const q of queues) {
      if (!q.entries.length && many) continue;
      any ||= q.entries.length > 0;
      if (many) ctx.io.out(q.project.name ?? q.project.id);
      for (const line of table(
        q.entries.map((e, i) => [
          `${i + 1}.`,
          `#${e.number}`,
          oneLine(e.title, 60),
          short(e.headSha),
          `queued ${ago(e.enqueuedAt, now)}`,
        ]),
      )) {
        ctx.io.out(many ? `  ${line}` : line);
      }
    }
    if (!any) ctx.io.out("The merge queue is empty.");
    return 0;
  },
};

function reportCreated(ctx: Ctx, c: Created, what: string) {
  const link = workLink(ctx, c.workItemId);
  if (c.outcome === "created") ctx.io.out(`Created #${c.number}: ${what}`);
  else if (c.outcome === "attached") ctx.io.out(`Already work item #${c.number}: ${what}`);
  else ctx.io.out(`Already filed as #${c.number} (duplicate): ${what}`);
  ctx.io.out(`  ${link}`);
}

const newCommand: Command = {
  usage: 'sf new "<title>" [--body <text> | --body-file <file|->] [--project <name|id>] [--json]',
  summary: "Send work to the factory",
  options: {
    body: { type: "string", short: "b" },
    "body-file": { type: "string" },
    project: { type: "string", short: "p" },
  },
  async run(ctx, values, args) {
    const title = args.join(" ").trim();
    if (values.body !== undefined && values["body-file"] !== undefined) {
      throw usage("pass --body or --body-file, not both");
    }
    const bodyFile = str(values["body-file"]);
    const body =
      bodyFile === undefined
        ? (str(values.body) ?? "")
        : bodyFile === "-"
          ? await ctx.io.readStdin()
          : await ctx.io.readFile(bodyFile);
    if (!title && !body.trim()) throw usage('give it a title: sf new "<title>"');
    const p = await resolveProject(ctx.scope, str(values.project));
    const created = await result<Created>(ctx.api, "workItem.create", {
      projectId: p.id,
      ...(title ? { title } : {}),
      body,
      source: "cli",
      // One id per invocation: a retried request is a no-op, not a second item.
      eventId: `cli:${randomUUID()}`,
      // `sf new` sends straight to the factory: create and release (ADR 0441).
      state: "queued",
    });
    if (values.json) printJson(ctx, created);
    else reportCreated(ctx, created, title || oneLine(body, 60));
    return 0;
  },
};

const attach: Command = {
  usage: "sf attach <pr-number> [--project <name|id>] [--json]",
  summary: "Attach a pull request opened outside the factory, to verify and merge it",
  options: { project: { type: "string", short: "p" } },
  async run(ctx, values, args) {
    const match = /^#?(\d+)$/.exec(args[0] ?? "");
    if (!match) throw usage("which pull request? sf attach <pr-number>");
    const prNumber = Number(match[1]);
    const p = await resolveProject(ctx.scope, str(values.project));
    const c = await result<Created>(ctx.api, "workItem.attachPr", { projectId: p.id, prNumber });
    if (values.json) printJson(ctx, c);
    else reportCreated(ctx, c, `pull request #${prNumber}`);
    return 0;
  },
};

const cancel: Command = {
  usage: "sf cancel <n|wi_id> --reason <text> [--project <name|id>]",
  summary: "Cancel a work item: stop its runs and close its gates",
  options: { reason: { type: "string", short: "r" }, project: { type: "string", short: "p" } },
  async run(ctx, values, args) {
    const reason = str(values.reason)?.trim();
    if (!reason) throw usage("say why: --reason <text>");
    const id = await resolveWorkItem(ctx.scope, args[0], str(values.project));
    const { cancelled } = await result<{ cancelled: boolean }>(ctx.api, "workItem.cancel", {
      workItemId: id,
      reason,
    });
    if (values.json) printJson(ctx, { cancelled });
    else if (cancelled) ctx.io.out(`Cancelled ${args[0]}.`);
    else ctx.io.out(`${args[0]} had already finished; nothing to cancel.`);
    return 0;
  },
};

const openCommand: Command = {
  usage: "sf open <n|wi_id> [--review] [--project <name|id>] [--no-open]",
  summary: "Open a work item (or its review packet) in the app, where gates are decided",
  options: {
    review: { type: "boolean" },
    project: { type: "string", short: "p" },
    "no-open": { type: "boolean" },
  },
  async run(ctx, values, args) {
    const ref = args[0];
    const id =
      ref && WORK_ITEM_ID.test(ref)
        ? ref
        : await resolveWorkItem(ctx.scope, ref, str(values.project));
    const link = workLink(ctx, id, values.review === true);
    ctx.io.out(link);
    if (!values["no-open"]) ctx.io.open?.(link);
    return 0;
  },
};

const tokens: Command = {
  usage: "sf tokens [revoke <tokenId>] [--json]",
  summary: "Your CLI tokens; `sf tokens revoke <id>` revokes one",
  async run(ctx, values, args) {
    if (args[0] === "revoke") {
      const tokenId = args[1];
      if (!tokenId) throw usage("which token? sf tokens revoke <tokenId>");
      const out = await result<unknown>(ctx.api, "cliToken.revoke", { tokenId });
      if (values.json) printJson(ctx, out);
      else ctx.io.out(`Revoked ${tokenId}.`);
      return 0;
    }
    if (args.length) throw usage(`unknown: sf tokens ${args.join(" ")}`);
    const out = await result<Record<string, unknown>>(ctx.api, "cliToken.list", {});
    if (values.json) {
      printJson(ctx, out);
      return 0;
    }
    const list = (Object.values(out ?? {}).find(Array.isArray) ?? []) as Record<string, unknown>[];
    const field = (t: Record<string, unknown>, ...keys: string[]) => {
      for (const k of keys) if (typeof t[k] === "string") return t[k] as string;
      return "";
    };
    const mine = ctx.config.tokenId;
    for (const line of table(
      list.map((t) => {
        const id = field(t, "id", "tokenId");
        return [
          `${id}${id && id === mine ? " (this one)" : ""}`,
          field(t, "name"),
          field(t, "scope"),
          `expires ${field(t, "expiresAt").slice(0, 10)}`,
          field(t, "revokedAt") ? "revoked" : "",
        ];
      }),
    )) {
      ctx.io.out(line);
    }
    if (!list.length) ctx.io.out("No tokens.");
    return 0;
  },
};

export const COMMANDS: Record<string, Command> = {
  login,
  logout,
  status: statusCommand,
  inbox,
  ls,
  show,
  timeline,
  queue,
  new: newCommand,
  attach,
  cancel,
  open: openCommand,
  ops,
  call,
  tokens,
};

export function helpText(): string[] {
  const rows = Object.values(COMMANDS).map((c) => [c.usage.split(" [")[0] ?? c.usage, c.summary]);
  return [
    "sf: the software factory from a terminal. Gate decisions stay in the app.",
    "",
    "Usage: sf <command> [options]   (sf <command> --help for its options)",
    "",
    ...table(rows).map((l) => `  ${l}`),
    "",
    "Every command takes --org <orgId> (or SF_ORG) when your org can't be inferred, and data",
    "commands take --json. <n> is a work item number in the project (--project, or your only one).",
    "",
    "Environment: SF_TOKEN (a token, overrides `sf login`), SF_URL (the engine), SF_APP_URL,",
    "SF_ORG, XDG_CONFIG_HOME (config in $XDG_CONFIG_HOME/software-factory/cli.json).",
  ];
}

// ---------------------------------------------------------------------------------------------
// Errors: say what to do next

/** The ops list for hints, fetched at most once and never fatal. */
function opsLookup(api: Api) {
  let list: Promise<OperationInfo[] | null> | null = null;
  return (name: string) => {
    list ??= api.ops().catch(() => null);
    return list.then((l) => l?.find((o) => o.name === name) ?? null);
  };
}

/** Wrap the API so a refused call carries a hint: log in, use the app, or ask for write. */
function hinting(api: Api, ctx: () => Ctx): Api {
  const lookup = opsLookup(api);
  return {
    ops: () => api.ops(),
    async call(op, input) {
      try {
        return await api.call(op, input);
      } catch (err) {
        if (err instanceof CliError) err.hint = await hintFor(ctx(), err, op, input, lookup);
        throw err;
      }
    },
  };
}

async function hintFor(
  ctx: Ctx,
  err: CliError,
  op: string,
  input: unknown,
  lookup: (name: string) => Promise<OperationInfo | null>,
): Promise<string | null> {
  if (err.status === 401 || err.code === "unauthenticated") {
    return ctx.settings.tokenSource === "env"
      ? "SF_TOKEN was refused (revoked, expired or unknown). Get a new token with `sf login`."
      : "Run `sf login`.";
  }
  if (err.status !== 403 || err.code !== "forbidden") return null;
  const info = await lookup(op);
  const marked = (err.details as { browserOnly?: unknown } | undefined)?.browserOnly === true;
  if (marked || info?.browserOnly === true || /in the app|ADR 0340/i.test(err.message)) {
    const wi =
      input && typeof input === "object" && "workItemId" in input
        ? String((input as { workItemId: unknown }).workItemId)
        : null;
    const link = wi ? workLink(ctx, wi, op.startsWith("review.")) : ctx.settings.appUrl;
    return `${op} is decided in the app, not from the CLI. Do it there: ${link}${wi ? ` (or \`sf open ${wi}\`)` : ""}`;
  }
  if (/sf login --write/.test(err.message)) return null;
  if (info && info.risk !== "read" && ctx.config.scope !== "write") {
    return ctx.settings.tokenSource === "env"
      ? `${op} is a ${info.risk} operation; SF_TOKEN may be a read token.`
      : `${op} is a ${info.risk} operation and this token is ${ctx.config.scope ?? "read"}-only. \`sf login --write\` for one that can write.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    for (const line of helpText()) io.out(line);
    return name ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`usage: unknown command ${name}. \`sf --help\` lists them.`);
    return 2;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...COMMON, ...command.options },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      io.out(`usage: ${command.usage}`);
      io.out(`  ${command.summary}`);
      return 0;
    }
    const file = configFile(io.env);
    const config = await loadConfig(file);
    const s = settings(config, io.env);
    const raw = httpApi({ url: s.url, token: s.token, fetch: io.fetch });
    const org = str(values.org) ?? (io.env.SF_ORG || undefined);
    const ctx: Ctx = {
      io,
      file,
      config,
      settings: s,
      api: raw,
      scope: { api: raw, org },
    };
    ctx.api = hinting(raw, () => ctx);
    ctx.scope = { api: ctx.api, org };
    return (await command.run(ctx, values, positionals)) ?? 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`${err.code}: ${err.message}`);
      if (err.hint) io.err(err.hint);
      return err.code === "usage" ? 2 : 1;
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      io.err(`usage: ${(err as Error).message}`);
      io.err(`  ${command.usage}`);
      return 2;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
