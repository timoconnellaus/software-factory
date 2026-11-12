// The document a planning mockup frame renders (spec 21, ADR 0472). A mockup is untrusted HTML: it
// renders from `srcdoc` in an `<iframe sandbox="allow-scripts">` with an opaque origin, behind the
// CSP below, which the app puts before anything of the planner's. The frame script talks to the
// app over `postMessage` only.

/** The CSP every mockup frame gets first (ADR 0472): CDNs for fonts and libraries, no calls home. */
export const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
  "img-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The script the app puts in each frame. It knows nothing of the app: it answers `apply`,
 * `preview`, `pin-mode` and `pins`, and posts `ready` and `pin` to its parent.
 */
const FRAME_SCRIPT = `(() => {
  const root = document.documentElement;
  let base = {}, preview = null, pinMode = false, pins = [];
  const loadFont = (value) => {
    const family = String(value).split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (!family || /^(serif|sans-serif|monospace|system-ui|inherit)$/i.test(family)) return;
    const id = "plan-font-" + family.replace(/\\W+/g, "-");
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id; link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(family) + ":wght@400;500;600;700&display=swap";
    document.head.appendChild(link);
  };
  const set = (values) => {
    for (const [control, value] of Object.entries(values)) {
      if (control.startsWith("--")) {
        root.style.setProperty(control, value);
        if (control.startsWith("--font")) loadFont(value);
      } else if (control.startsWith("@")) {
        const attr = "data-plan-" + control.slice(1);
        const els = document.querySelectorAll("[" + attr + "]");
        (els.length ? els : [document.body]).forEach((el) => el.setAttribute(attr, value));
      } else if (control.startsWith("#")) {
        document.querySelectorAll('[data-plan-text="' + control.slice(1) + '"]').forEach((el) => { el.textContent = value; });
      }
    }
  };
  const render = () => set(Object.assign({}, base, preview || {}));
  const describe = (el) => {
    const named = el.closest("[data-name]");
    if (named) return { el: named, element: named.getAttribute("data-name"), selector: null };
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    const tag = el.tagName.toLowerCase();
    const parts = []; let node = el;
    while (node && node !== document.body && parts.length < 6) {
      const parent = node.parentElement; if (!parent) break;
      const index = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")"); node = parent;
    }
    return { el, element: text ? tag + ' "' + text + '"' : tag, selector: "body > " + parts.join(" > ") };
  };
  const drawPins = () => {
    document.querySelectorAll("[data-plan-pin]").forEach((n) => n.remove());
    for (const p of pins) {
      const dot = document.createElement("div");
      dot.setAttribute("data-plan-pin", "");
      dot.textContent = String(p.n);
      dot.style.cssText = "position:absolute;z-index:2147483647;left:" + (p.x - 11) + "px;top:" + (p.y - 11) + "px;width:22px;height:22px;border-radius:11px 11px 11px 2px;background:#16a34a;color:#fff;font:600 11px/22px system-ui;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.3);pointer-events:none";
      document.body.appendChild(dot);
    }
  };
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "apply") { base = m.values || {}; render(); }
    else if (m.type === "preview") { preview = m.values || null; if (!preview) { set(base); } render(); }
    else if (m.type === "pin-mode") { pinMode = !!m.on; root.style.cursor = pinMode ? "crosshair" : ""; }
    else if (m.type === "pins") { pins = Array.isArray(m.pins) ? m.pins : []; drawPins(); }
  });
  addEventListener("click", (e) => {
    if (!pinMode) return;
    e.preventDefault(); e.stopPropagation();
    const d = describe(e.target);
    const box = d.el.getBoundingClientRect();
    parent.postMessage({ type: "pin", element: d.element, selector: d.selector,
      x: e.pageX, y: e.pageY,
      fx: box.width ? Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) : 0,
      fy: box.height ? Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) : 0,
      width: root.scrollWidth }, "*");
  }, true);
  const ready = () => parent.postMessage({ type: "ready", height: root.scrollHeight }, "*");
  if (document.readyState === "complete") ready(); else addEventListener("load", ready);
})();`;

/** The document a frame renders: the CSP and the frame script first, then the planner's HTML. */
export function frameDocument(content: string): string {
  // Always at the very start, never found by searching the planner's HTML: a `<head>` inside a
  // comment or a string would otherwise put the CSP somewhere the browser ignores. The planner's
  // own doctype goes (ours keeps standards mode); its `<html>` and `<head>` tags then just carry on
  // the head the parser has already opened.
  const html = content.replace(/<!doctype[^>]*>/gi, "");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${FRAME_SCRIPT}</script>${html}`;
}
