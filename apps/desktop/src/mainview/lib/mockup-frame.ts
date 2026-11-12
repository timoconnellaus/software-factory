// The document a planning mockup frame renders (spec 21, ADR 0472, review of #90). A mockup is
// untrusted HTML, rendered in two levels:
// - the OUTER frame is the app's own document (`outerDocument`), in `<iframe sandbox="allow-scripts">`
//   with an opaque origin. Its CSP allows no frame navigation (`frame-src 'none'`), so the mockup
//   inside can't navigate itself anywhere (a meta refresh, `location =`, a link): the browser refuses
//   the navigation. A small watcher puts the mockup back if the inner frame ever loads twice.
// - the INNER frame is the mockup (`frameDocument`), from `srcdoc`, in its own `sandbox="allow-scripts"`
//   (no popups, forms, top navigation or same origin). A srcdoc document inherits the outer's CSP,
//   and the mockup gets the same CSP again first in its head, so nothing it adds can loosen it.
// The CSP allows the CDNs for libraries, styles, fonts and images, and nothing else: no fetch, no
// images from anywhere, no forms. The app talks only to the inner frame's window over `postMessage`.

/** The CDNs a mockup may load from (ADR 0472). */
const CDNS = [
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
];

/** The CSP every mockup frame gets first (ADR 0472): CDNs for fonts and libraries, no calls home. */
export const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDNS.join(" ")}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS.join(" ")}`,
  `font-src https://fonts.gstatic.com ${CDNS.join(" ")} data:`,
  `img-src data: blob: ${CDNS.join(" ")}`,
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The script the app puts in each frame. It knows nothing of the app: it answers `apply`,
 * `preview`, `pin-mode` and `pins` from the app (its parent's parent), and posts `ready` and `pin` to it.
 */
const FRAME_SCRIPT = `((nonce) => {
  // The nonce proves this document to the outer frame; the script takes itself out of the DOM so
  // the mockup can never read it.
  document.currentScript?.remove();
  // No WebRTC (review of #90): CSP doesn't govern it, so a mockup could reach any STUN server. Its
  // constructors go before the mockup runs, and a child frame's window isn't handed out (where a
  // fresh frame would have them again). Best effort: see ADR 0472 for what the WebView must do.
  for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport", "RTCRtpTransceiver"]) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  for (const C of [HTMLIFrameElement, HTMLFrameElement, HTMLObjectElement, HTMLEmbedElement]) {
    for (const p of ["contentWindow", "contentDocument"]) {
      try { Object.defineProperty(C.prototype, p, { get: () => null, configurable: false }); } catch {}
    }
  }
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
      const up = node.parentElement; if (!up) break;
      const index = Array.prototype.indexOf.call(up.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")"); node = up;
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
    if (e.source !== parent.parent || !e.data || typeof e.data !== "object") return;
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
    parent.parent.postMessage({ type: "pin", element: d.element, selector: d.selector,
      x: e.pageX, y: e.pageY,
      fx: box.width ? Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) : 0,
      fy: box.height ? Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)) : 0,
      width: root.scrollWidth }, "*");
  }, true);
  const ready = () => {
    parent.postMessage({ type: "here", nonce }, "*");
    parent.parent.postMessage({ type: "ready", height: root.scrollHeight }, "*");
  };
  if (document.readyState === "complete") ready(); else addEventListener("load", ready);
})(__NONCE__);`;

/** The document a frame renders: the CSP and the frame script first, then the planner's HTML. */
export function frameDocument(content: string, nonce = ""): string {
  // Always at the very start, never found by searching the planner's HTML: a `<head>` inside a
  // comment or a string would otherwise put the CSP somewhere the browser ignores. The planner's
  // own doctype goes (ours keeps standards mode); its `<html>` and `<head>` tags then just carry on
  // the head the parser has already opened.
  const html = content.replace(/<!doctype[^>]*>/gi, "");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${FRAME_SCRIPT.replace("__NONCE__", JSON.stringify(nonce))}</script>${html}`;
}

/** What a mockup that keeps trying to leave its frame is replaced with. */
const STOPPED =
  '<!doctype html><body data-mockup-stopped="1" style="font:13px system-ui;color:#555;padding:16px">This mockup tried to leave its frame and was stopped.</body>';

/** Escapes text for an HTML attribute value in double quotes. */
const attr = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The outer document: the app's own, holding the mockup in a nested sandboxed frame. Its CSP
 * forbids frame navigation, so the mockup can't leave; the watcher puts the mockup back when its frame
 * holds anything else (a refused navigation's error page), and tells the app (`reset`).
 */
export function outerDocument(content: string): string {
  const nonce = crypto.randomUUID();
  const inner = attr(frameDocument(content, nonce));
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{border:0;display:block;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${inner}"></iframe><script>(() => {
  const frame = document.querySelector("iframe");
  const doc = frame.getAttribute("srcdoc");
  // Every document the frame loads must be the mockup, which says so with the nonce once it has
  // loaded. A navigation the CSP refused leaves an error page that never does: put the mockup back,
  // and after two tries stop it with a notice (no scripts) instead of letting it loop.
  let loads = 0, heres = 0, resets = 0, stopped = false;
  addEventListener("message", (e) => {
    if (e.source === frame.contentWindow && e.data && e.data.type === "here" && e.data.nonce === ${JSON.stringify(nonce)}) heres++;
  });
  frame.addEventListener("load", () => {
    loads++;
    setTimeout(() => {
    if (stopped || loads <= heres) return;
    loads = 0;
    heres = 0;
    if (++resets > 2) {
      stopped = true;
      frame.setAttribute("sandbox", "");
      frame.setAttribute("srcdoc", ${JSON.stringify(STOPPED)});
      parent.postMessage({ type: "stopped" }, "*");
      return;
    }
    frame.setAttribute("srcdoc", doc);
    parent.postMessage({ type: "reset" }, "*");
    }, 700);
  });
})();</script></body></html>`;
}
