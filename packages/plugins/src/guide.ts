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
    entered(ctx, { item, from, to }) {},   // after an item enters a status (from is null for a new item)
    leaving(ctx, { item, from, to }) {},   // before an item leaves a status; return { refuse: "why" } to stop the move
    runEnded(ctx, { item, run }) {},       // after an agent's run ends; run: { id, agentId, statusId, outcome: "done" | "rejected" | "failed", summary }
    trigger(ctx, { name, payload }) {},    // an outside event arrived for this plugin (see Triggers)
  },
};
\`\`\`

## ctx: how a plugin acts (await every call)
- \`ctx.item\`: the item as plain data: { id, number, title, body, statusId, fields }. Null in a trigger.
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
