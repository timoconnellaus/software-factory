// What an agent reads before it writes a plugin (the MCP server's `plugin_guide`), and saving one
// only once it loads.
import { type Plugin, savePlugin } from "@software-factory/store";
import type { PluginHostEnv } from "./types.ts";
import { inspectPlugin } from "./worker.ts";

export const PLUGIN_GUIDE = `# Writing a plugin

A plugin is one ES module of JavaScript, saved by name in this org. It is live at once, for every
item in the org. Its default export:

\`\`\`js
export default {
  // Optional. Extra fields on this org's items, shown on the board card and the item.
  fields: [{ id: "customer", label: "Customer", type: "text" }], // type: "text" | "number" | "date"
  // Optional. Called by the engine. Each may be async.
  on: {
    entered(ctx, { item, from, to, fromName, toName }) {}, // after an item enters a status (from is null for a new item)
    leaving(ctx, { item, from, to, fromName, toName }) {}, // before it leaves one; return { refuse: "why" } to stop the move
    runEnded(ctx, { item, run }) {},       // after an agent's run ends; run: { id, agentId, statusId, outcome: "done" | "rejected" | "failed", summary, branch, headSha }
    trigger(ctx, { name, payload }) {},    // an outside event arrived for this plugin (see Triggers)
  },
};
\`\`\`

## ctx: how a plugin acts (await every call)
- \`ctx.item\`: the item as plain data: { id, number, title, body, statusId, fields, branch, headSha,
  repo }. Null in a trigger. \`repo\` is its project's GitHub repository, { owner, name,
  defaultBranch }, or null. \`branch\` is the item's branch there (factory/flow-<key>-<number>), set
  once an agent's run on it starts; \`headSha\` is the head the last run that ended done pushed.
- \`from\` and \`to\` are status ids; \`fromName\` and \`toName\` are the statuses' names.
- \`await ctx.comment(text)\`: a comment on the item's timeline, from the plugin.
- \`await ctx.card({ kind, title, subtitle?, rows?: [{ label, value }], checks?: [{ label, ok }],
  bars?: [{ label, value, max }], link?: { label, url } })\`: a rich card on the item's timeline.
- \`await ctx.setField(id, value)\`: set one of the item's fields (text, a number, or null to clear).
- \`await ctx.move(statusId)\`: move the item, once this hook returns. Its hooks run too; more than
  10 plugin moves in a row stop the item.
- \`await ctx.createItem({ projectId, title, body, fields? })\`: create an item (for triggers). Returns it.
- \`await ctx.gateway(name).fetch(path, { method, headers, body })\`: call an outside system through
  one of the org's gateways (gateway_list shows them). The path goes under the gateway's base URL
  and the gateway adds its credentials. Returns a Response. A body that isn't a string is sent as JSON.

The plugin has no network of its own: fetch() throws. Use a gateway.

## GitHub: the built-in \`github\` gateway
An org that has connected GitHub has a gateway named \`github\` that nobody sets up or edits.
\`ctx.gateway("github").fetch(path, init)\` calls the GitHub REST API for the repository of the
item's project: the path goes under \`https://api.github.com/repos/<owner>/<name>\` (so
\`"/pulls"\`, \`"/commits/<sha>/check-runs"\`), with a token that may write contents and pull
requests and read checks. A hook with no item, or an item whose project has no repository, gets an
error. An agent's run on such an item works in a checkout on the item's branch and the runner
pushes it; \`runEnded\`'s \`run.headSha\` (and \`ctx.item.headSha\`) is what it pushed.

## Failure
If a hook throws, takes longer than 10 seconds, or \`leaving\` returns anything but nothing or
{ refuse: "why" }, the item stops with \`Plugin "<name>" failed: <message>\`. A person retries it
once the plugin is fixed; a retry runs the status's \`entered\` hooks again.

## Triggers
Each plugin has a URL: POST /flow/triggers/<pluginId>/<name>?key=<triggerKey> (plugin_read shows
the id and key). A request with the right key calls \`on.trigger\` with the JSON body as \`payload\`.

## Example: when an item reaches Published, post it and put the link on the item

\`\`\`js
export default {
  fields: [{ id: "postUrl", label: "Post", type: "text" }],
  on: {
    async entered(ctx, { to, item }) {
      if (to !== "published") return;
      const res = await ctx.gateway("blog").fetch("/posts", {
        method: "POST",
        body: { title: item.title, body: item.body },
      });
      if (!res.ok) throw new Error("The blog said " + res.status + ": " + (await res.text()));
      const post = await res.json();
      await ctx.setField("postUrl", post.url);
      await ctx.card({ kind: "link", title: "Posted to the blog", link: { label: "Open the post", url: post.url } });
    },
    leaving(ctx, { from, item }) {
      if (from === "review" && !item.body.trim()) return { refuse: "The post has no text yet." };
    },
  },
};
\`\`\`

## Example: software, with pull requests (plugins/software/plugin.js in the repository)

\`\`\`js
// The software plugin: pull requests for the items of a project with a GitHub repository.
// - When an agent's run ends \`done\` and has pushed the item's branch, it opens a pull request from
//   that branch into the default branch (unless one is open), keeps its number in the item's \`pr\`
//   field, and adds a card with the pull request, its size and its checks.
// - An item can't leave a status whose name has "review" in it while a check on the pull request's
//   head has failed or is still running.
// - When an item enters "Merged" or "Shipped", its open pull request is merged (a merge commit).
// Everything goes through the built-in \`github\` gateway, on the repository of the item's project.

const FAILED = ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"];

async function gh(ctx, path, init) {
  const res = await ctx.gateway("github").fetch(path, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

function why(res) {
  const message = res.body && typeof res.body === "object" ? res.body.message : res.body;
  return \`GitHub said \${res.status}\${message ? \`: \${message}\` : ""}\`;
}

async function pull(ctx, number) {
  const res = await gh(ctx, \`/pulls/\${number}\`);
  if (!res.ok) throw new Error(\`Couldn't read pull request #\${number}. \${why(res)}\`);
  return res.body;
}

async function checksOn(ctx, sha) {
  const res = await gh(ctx, \`/commits/\${sha}/check-runs?per_page=100\`);
  if (!res.ok) throw new Error(\`Couldn't read the checks on \${sha.slice(0, 7)}. \${why(res)}\`);
  return res.body.check_runs.map((c) => ({
    name: c.name,
    running: c.status !== "completed",
    failed: c.status === "completed" && FAILED.includes(c.conclusion),
  }));
}

async function card(ctx, pr) {
  const checks = await checksOn(ctx, pr.head.sha);
  await ctx.card({
    kind: "pull-request",
    title: \`#\${pr.number} \${pr.title}\`,
    subtitle: \`+\${pr.additions} −\${pr.deletions}\`,
    checks: checks.map((c) => ({
      label: c.running ? \`\${c.name} (running)\` : c.name,
      ok: !c.running && !c.failed,
    })),
    link: { label: "Open on GitHub", url: pr.html_url },
  });
}

export default {
  fields: [{ id: "pr", label: "Pull request", type: "number" }],
  on: {
    async runEnded(ctx, { item, run }) {
      if (run.outcome !== "done" || !item.repo || !item.branch || !item.headSha) return;
      const open = await gh(
        ctx,
        \`/pulls?state=open&head=\${encodeURIComponent(\`\${item.repo.owner}:\${item.branch}\`)}\`,
      );
      if (!open.ok) throw new Error(\`Couldn't list the pull requests. \${why(open)}\`);
      let number = open.body[0]?.number;
      if (number === undefined) {
        const made = await gh(ctx, "/pulls", {
          method: "POST",
          body: {
            title: item.title,
            head: item.branch,
            base: item.repo.defaultBranch,
            body: \`\${run.summary}\\n\\nFor item #\${item.number}: \${item.title}\`,
          },
        });
        if (!made.ok) throw new Error(\`Couldn't open a pull request. \${why(made)}\`);
        number = made.body.number;
      }
      await ctx.setField("pr", number);
      await card(ctx, await pull(ctx, number));
    },

    async leaving(ctx, { item, fromName }) {
      if (!/review/i.test(fromName ?? "") || typeof item.fields.pr !== "number") return;
      const pr = await pull(ctx, item.fields.pr);
      const checks = await checksOn(ctx, pr.head.sha);
      const failed = checks.filter((c) => c.failed).map((c) => c.name);
      const running = checks.filter((c) => c.running).map((c) => c.name);
      if (failed.length === 0 && running.length === 0) return;
      const said = [];
      if (failed.length) said.push(\`failed: \${failed.join(", ")}\`);
      if (running.length) said.push(\`still running: \${running.join(", ")}\`);
      return { refuse: \`The pull request's checks haven't passed (\${said.join("; ")}).\` };
    },

    async entered(ctx, { item, toName }) {
      if (!/^(merged|shipped)$/i.test(toName.trim()) || typeof item.fields.pr !== "number") return;
      const pr = await pull(ctx, item.fields.pr);
      if (pr.state !== "open" || pr.merged) return;
      const merged = await gh(ctx, \`/pulls/\${pr.number}/merge\`, {
        method: "PUT",
        body: { merge_method: "merge", sha: pr.head.sha },
      });
      if (!merged.ok) throw new Error(\`Couldn't merge #\${pr.number}. \${why(merged)}\`);
      await ctx.card({
        kind: "pull-request",
        title: \`Merged #\${pr.number} \${pr.title}\`,
        subtitle: \`into \${pr.base.ref}\`,
        link: { label: "Open on GitHub", url: pr.html_url },
      });
    },
  },
};
\`\`\`
`;

/**
 * Saves a plugin only if its code loads and its default export has the right shape; what it
 * declares (fields, hooks) is stored beside it. `{ ok: false, error }` otherwise, and nothing is
 * written.
 */
export async function savePluginChecked(
  env: PluginHostEnv,
  input: { orgId: string; name: string; request: string; code: string; createdBy: string },
): Promise<{ ok: true; plugin: Plugin } | { ok: false; error: string }> {
  const inspected = await inspectPlugin(env, input.orgId, input.code);
  if (!inspected.ok) return inspected;
  const plugin = await savePlugin(env.DB, { ...input, ...inspected.declaration });
  return { ok: true, plugin };
}
