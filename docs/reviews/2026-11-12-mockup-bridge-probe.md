# Probe: can a planning mockup frame reach the Electrobun bridge? (review of #90, item 4)

**Status: not run yet.** Spec 21's mockups must not be enabled in the desktop app until this has
run and found nothing reachable. The desktop session runs it; the result goes on #90.

## Why
The desktop app is a WKWebView. Electrobun's preload (`.hutch/devkit/api/preload/index.ts`) reads
globals the native side installs (`__electrobunInternalBridge`, `__electrobunHostBridge`,
`__electrobunBunBridge`, `__electrobunEventBridge`, `__electrobunSecretKeyBytes`, ...) and talks to
Bun through WebKit script message handlers. A WKScriptMessageHandler is normally visible in every
frame (`window.webkit.messageHandlers`), sandboxed or not, unless the native side registers it for
the main frame only. Mockup frames are sandboxed with opaque origins (ADR 0472), so the app window's
own globals can't be read from them, but a message handler could still be reached.

## Steps
1. Build and launch the desktop app from this branch (`pnpm --filter @software-factory/desktop dev`)
   when the machine isn't loaded, signed in to a dev factory.
2. Open a work item in planning, and have the planner (or `artifact.add` over MCP) add this mockup:

```html
<!doctype html><html><body data-mockup="1"><pre id="out">probing…</pre><script>
const r = {};
r.webkit = typeof window.webkit;
r.handlers = (() => { try { return Object.keys(window.webkit?.messageHandlers ?? {}); } catch (e) { return "error: " + e; } })();
r.globals = Object.getOwnPropertyNames(window).filter((k) => /electrobun|bun/i.test(k));
r.secretKey = typeof window.__electrobunSecretKeyBytes;
r.parentGlobals = (() => { try { return Object.keys(parent.parent).filter((k) => /electrobun/i.test(k)); } catch (e) { return "blocked: " + e.name; } })();
r.posts = {};
for (const name of ["bunBridge", "internalBridge", "hostBridge", "eventBridge", ...(Array.isArray(r.handlers) ? r.handlers : [])]) {
  try { window.webkit?.messageHandlers?.[name]?.postMessage(JSON.stringify({ probe: "mockup", type: "request", method: "probe" })); r.posts[name] = "posted"; }
  catch (e) { r.posts[name] = "error: " + e.name; }
}
document.getElementById("out").textContent = JSON.stringify(r, null, 2);
</script></body></html>
```

3. Open the Mockups tab and read the frame's text (or open Web Inspector on the app and inspect the
   inner frame). Also watch the Bun process's log for anything the posts caused.

## Reading it
- **Nothing reachable** (the result to want): `webkit` is `undefined` or `handlers` is `[]`, `globals`
  is `[]`, `secretKey` is `undefined`, `parentGlobals` is `blocked: SecurityError`, every `posts`
  entry is absent or an error, and the Bun log shows nothing from the posts.
- **Reachable**: any handler name listed, any `posted`, or any `__electrobun*` global. Then it's a
  blocker for the desktop app as a whole: the fix is registering the handlers for the main frame
  only (or in a content world the page can't see) in the shell, and rerunning this probe.
