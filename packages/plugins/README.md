# @software-factory/plugins

The new core's plugin host (ADR 0660, spec 70 milestone 2). A plugin is one ES module of
JavaScript, stored in D1 (`flow_plugins`), belonging to one org, written by an agent from a
person's plain words. This package loads it as a Cloudflare Dynamic Worker, runs its hooks around
every item event, serves its `ctx` back to it, and makes its gateway calls. It never imports the
old core (`packages/core`), and no source file is over 400 lines.

Kept simple on purpose (the owner, 2026-11-15): no limits on what a plugin does, no grants, no
approval of edits, no versions. A save is live at once, everywhere in the org. A plugin that fails
stops the item with the error, and the item can be retried. That is the whole failure model.

## The contract
```js
export default {
  fields: [{ id: "customer", label: "Customer", type: "text" }], // "text" | "number" | "date"
  on: {
    entered(ctx, { item, from, to }) {},  // after an item enters a status (from is null for a new item)
    leaving(ctx, { item, from, to }) {},  // before it leaves one; return { refuse: "why" } to stop the move
    runEnded(ctx, { item, run }) {},      // after an agent's run ends: { id, agentId, statusId, outcome, summary }
    trigger(ctx, { name, payload }) {},   // an outside event for this plugin
  },
};
```
`ctx`: `item` (plain data: id, number, title, body, statusId, fields), `comment(text)`,
`card({ kind, title, subtitle?, rows?, checks?, bars?, link? })`, `setField(id, value)`,
`move(statusId)`, `createItem({ projectId, title, body, fields? })`, and
`gateway(name).fetch(path, init)`, which returns a `Response`. `PLUGIN_GUIDE` (guide.ts) is the
same contract written for an agent, with a complete example; the engine's MCP server serves it.

## How it runs
- **The worker** (worker.ts). `loadPlugin` calls the Worker Loader binding (`env.LOADER.get`) with
  two modules: the plugin's code as `plugin.js`, and a small generated `index.js` (`WRAPPER`)
  whose default export is a `WorkerEntrypoint` with `describe()` (what the module declares) and
  `run(hook, payload, host)`. The loader id is `flow-plugin:<orgId>:<sha256(wrapper + code)>`, so
  an edited plugin is a new worker and an unchanged one is reused. `globalOutbound: null`: the
  plugin's own `fetch()` and `connect()` throw. Its `env` is empty.
- **`ctx`** (ctx.ts). `PluginCtx` is an `RpcTarget` the host passes as the third argument of each
  `run` call. The worker wraps it into the `ctx` above; every call runs back in the engine, with the
  engine's D1 and network, and only for as long as the hook runs (a late call is refused). Moves
  and created items are applied after the hook returns, with their own hooks.
- **Dispatch** (dispatch.ts). `dispatch(env, orgId, hook, payload, { item })` runs `hook` in every
  enabled plugin of the org that defines it, in name order, each under a 10-second deadline. A
  throw, a timeout or an invalid `leaving` return is a failure: `last_error` is recorded on the
  plugin, the item stops with `Plugin "<name>" failed: <message>`, and nothing after it runs.
  `leaving` ends at the first refusal. Which hooks a plugin defines is stored when it is saved, so
  plugins that don't define a hook are never loaded for it.
- **The one way an item moves** (steps.ts). `applyItemEvent`, `createItemWithHooks`,
  `endRunWithHooks` and `expireRunsWithHooks` are what every caller uses (the `flow.item.*`
  operations, the runner's hand-back and failure, the lease sweep, and plugins' own moves). The
  order is always: if the event would take the item out of its status (worked out with the pure
  kernel, writing nothing), `leaving`; then the event through the store; then `runEnded` if a run
  ended and `entered` if the item entered a status; then the plugins' moves, each the same way. A
  refusal of a person's or agent's move is a `PluginRefusal` (the door answers `conflict` with the
  reason); a refusal of a run's hand-back records the run as done and stops the item with the
  reason. A retry runs the status's `entered` hooks again. More than 10 plugin moves in a row stop
  the item.
- **Gateways** (gateway.ts). `ctx.gateway(name).fetch(path, init)` resolves the org's gateway,
  joins its base URL and the path (a path that leaves the base is refused), adds
  `Authorization: Bearer <secret>` or `<header>: <secret>` from the decrypted secret, makes the
  request from the engine, and returns status, headers and body. A missing gateway is a plain error
  the plugin sees.
- **Fields.** A plugin's `fields` are read when it is saved (`describe()`) and stored on its row;
  `declaredFields` (packages/store) unions them across the org's enabled plugins with one query.
  No worker is loaded to read a board or an item.
- **Triggers** (trigger.ts). `fireTrigger` runs one plugin's `on.trigger` if the key matches its
  `trigger_key`. The engine's route is `POST /flow/triggers/<pluginId>/<name>?key=<key>`, with the
  JSON body (at most 256 KiB) as `payload`. Items it creates belong to the person who saved the
  plugin, so their runners serve them.
- **Saving** (guide.ts). `savePluginChecked` loads the code and refuses it, with the load error,
  unless it loads and its default export has the right shape.

## Not in this milestone
Screens, tools for agents, and changes to an agent's brief are part of the long-term design (ADR
0660) but not built here. Nor are: approval of plugin edits, limits, trying a change on one item
first, sharing plugins between orgs, or a marketplace.

## Tests
`pnpm --filter @software-factory/plugins test` runs in workerd with a real Worker Loader
(`workerLoaders` in vitest.config.ts): plugins run as real Dynamic Workers. The engine's
`test/flow-plugins.test.ts` runs them through the real routes.
