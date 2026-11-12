# Probe: can a planning mockup frame reach the Electrobun bridge? (review of #90, item 4)

**Status: not run yet.** Mockups are off in the desktop app (`mockupsEnabled()` in
`apps/desktop/src/mainview/components/planning-visuals.tsx`, default off) until this probe has run in the
real app and found nothing reachable. The desktop session runs it; the result goes on #90.

## What could be reachable
The preload (`.hutch/devkit/api/preload/`) talks to Bun through bridges the native side installs:
- `__electrobunInternalBridge`: internal RPC. `internalRpc.ts` posts a JSON **array of JSON strings**:
  `{"type":"message","id":<handler>,"payload":…}` or
  `{"type":"request","method":<handler>,"id":<reqId>,"params":…,"hostWebviewId":<webviewId>}`.
- `__electrobunEventBridge` (falls back to the internal bridge): `events.ts` posts one JSON string,
  `{"id":"webviewEvent","type":"message","payload":{"id":<webviewId>,"eventName":…,"detail":…}}`.
- `__electrobunHostBridge` / `__electrobunBunBridge`: user RPC. The app's own RPC is encrypted with
  `__electrobunSecretKeyBytes` over the RPC socket, which the frame's CSP (`connect-src 'none'`) blocks
  anyway.

On macOS these are WKScriptMessageHandlers. **WebKit's `window.webkit.messageHandlers` has no enumerable
keys even when handlers exist**, so listing its keys proves nothing. Only a successful `postMessage` to a
named handler, and an effect on the Bun side, does.

## The observable effect
`apps/desktop/src/bun/index.ts` handles the main webview's `dom-ready` by **closing every open terminal**
(`terminals.closeAll()`). So a forged `webviewEvent` `dom-ready` that Bun accepts from a subframe closes
the terminals: visible at once, and harmless.

## Steps
1. Build and launch the desktop app from #90's branch when the machine isn't loaded
   (`pnpm --filter @software-factory/desktop dev`), signed in to a dev factory.
2. In the app's Web Inspector console (main frame), run `localStorage["sf-mockups"] = "on"` and reload.
3. Open a work item with **an open terminal** (Open terminal in the header, so a terminal pane is live).
4. Have the planner (or `artifact.add` over MCP) add this mockup, then open the Mockups tab:

```html
<!doctype html><html><body data-mockup="1"><pre id="out">probing…</pre><script>
const out = [];
const log = (k, v) => out.push(k + ": " + v);
const names = ["internalBridge", "eventBridge", "hostBridge", "bunBridge"];
// Each bridge two ways: a window global, and a WebKit message handler by name (not enumerable).
const bridges = [];
for (const n of names) {
  const g = window["__electrobun" + n[0].toUpperCase() + n.slice(1)];
  log("global __electrobun" + n, typeof g);
  if (g && typeof g.postMessage === "function") bridges.push(["global " + n, g]);
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers[n];
  log("webkit.messageHandlers." + n, typeof h);
  if (h && typeof h.postMessage === "function") bridges.push(["handler " + n, h]);
}
log("secretKey", typeof window.__electrobunSecretKeyBytes);
// Real messages, shaped as the preload sends them. Webview ids are small integers: try 1..8.
for (const [name, b] of bridges) {
  for (let id = 1; id <= 8; id++) {
    const event = JSON.stringify({ id: "webviewEvent", type: "message", payload: { id, eventName: "dom-ready", detail: "" } });
    const internal = JSON.stringify([JSON.stringify({ type: "message", id: "webviewEvent", payload: { id, eventName: "dom-ready", detail: "" } })]);
    try { b.postMessage(event); b.postMessage(internal); log("posted via " + name + " id " + id, "ok"); }
    catch (e) { log("post via " + name + " id " + id, "threw " + e.name); }
  }
}
document.getElementById("out").textContent = out.join("\n");
</script></body></html>
```

5. Read the frame's text, and watch the terminal pane and the Bun process log.

## Reading it
- **Reachable (a blocker for the desktop app as a whole)**, if any of:
  - the terminal pane closed (Bun accepted a forged `dom-ready` from the frame);
  - any line reads `posted via … ok` (a handler exists and accepted the post, even with no visible
    effect);
  - any `global __electrobun… : object`, or `secretKey: object`.

  The fix is in the shell: register the handlers for the main frame only (or in a content world the
  page can't see), and have Bun check the sender frame. Then rerun this probe.
- **Nothing reachable**: every `global` and `webkit.messageHandlers` line is `undefined`, there's no
  `posted via` line, `secretKey: undefined`, the terminals stay open, and the Bun log shows nothing from
  the posts. Then mockups may be turned on in the desktop app (flip `mockupsEnabled()`'s default).
