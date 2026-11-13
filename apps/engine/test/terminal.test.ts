// The web terminal's relay (spec 35, ADR 0440), in workerd with real bindings: the held `terminal`
// call on the signed channel, the TerminalRelay Durable Object with real WebSocket pairs, the
// viewer's attach through EngineApi, read-only enforcement in the relay, caps and the journal.
import { env } from "cloudflare:workers";
import { type Actor, FOREMAN } from "@software-factory/core";
import {
  type ChannelCallError,
  httpControlPlane,
  type Job,
  runnerChannelKey,
  TERMINAL_FRAME_MAX,
  TERMINAL_INPUT_MAX,
  TERMINAL_MAX_VIEWERS,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { HELD_POLL_MS } from "../src/channel.ts";
import worker from "../src/index.ts";
import { EngineApi } from "../src/rpc.ts";
import { terminalRelay } from "../src/terminal-relay.ts";
import { all, MANIFEST, ok, uid, type World, waitFor, world } from "./helpers.ts";
import { type Recorded, recordingEnv } from "./query-plans.ts";

const base = "https://sf-engine.example";
const engineFetch: typeof fetch = async (input, init) =>
  worker.fetch(new Request(input, init), env);

const api = () =>
  new EngineApi({ waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as never, env);

/** One end of a socket, with everything it received. */
interface End {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  bytes: string[];
  reading: number;
  closed: { code: number; reason: string } | null;
  until(what: string, ok: (end: End) => boolean): Promise<void>;
}

function end(ws: WebSocket): End {
  const e: End = {
    ws,
    texts: [],
    bytes: [],
    reading: 0,
    closed: null,
    async until(what, test) {
      await waitFor(what, async () => e.reading === 0 && test(e), 5_000);
    },
  };
  ws.addEventListener("message", (m) => {
    if (typeof m.data === "string") e.texts.push(JSON.parse(m.data));
    else {
      // Binary frames arrive as a Blob here; keep their order while they are read.
      const slot = e.bytes.length;
      e.bytes.push("");
      e.reading++;
      void (m.data as Blob).text().then((t) => {
        e.bytes[slot] = t;
        e.reading--;
      });
    }
  });
  ws.addEventListener("close", (c) => {
    e.closed = { code: c.code, reason: c.reason };
  });
  ws.accept();
  return e;
}

const has = (t: string) => (e: End) => e.texts.some((m) => m.t === t);

async function running(w: World, capabilities = [...MANIFEST.capabilities, "terminal" as const]) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title: "Show me the terminal" },
    w.human,
  );
  const c = httpControlPlane({
    baseUrl: base,
    runnerId: w.runner.runnerId,
    key: await runnerChannelKey("test-channel-secret", w.runner.runnerId, 1),
    fetch: engineFetch,
  });
  let job: Job | null = null;
  for (let i = 0; i < 100 && !job; i++) {
    job = (
      await c.claim({
        claimId: uid("claim-"),
        manifest: { ...MANIFEST, capabilities },
        capacity: { max: 2, inUse: 0, accepting: true },
      })
    ).job;
    if (!job) await new Promise((r) => setTimeout(r, 50));
  }
  if (!job) throw new Error("no job");
  const live = await ok<{ run: { id: string } }>(
    "run.live",
    { workItemId: item.workItemId },
    w.human,
  );
  return { c, job, item, runId: live.run.id };
}

async function member(orgId: string) {
  const id = uid("usr_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
    ).bind(id, `${id}@example.com`, now, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
    ).bind(uid("mem_"), orgId, id, now),
  ]);
  return { type: "human" as const, id };
}

/** A person opens the run's web terminal as sf-app does: attach, then the viewer socket. */
async function view(workItemId: string, runId: string, actor: Actor) {
  const attached = await api().terminalAttach(workItemId, runId, {
    actor,
    origin: { surface: "app" },
  });
  if (!attached.ok) throw new Error(`${attached.error.code}: ${attached.error.message}`);
  const res = await api().fetch(
    new Request(`https://sf-engine.internal${attached.path}`, {
      headers: { upgrade: "websocket" },
    }),
  );
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error("no socket");
  return { ...attached, end: end(res.webSocket) };
}

/** A token for the person, as the desktop app's sign-in (or `sf login`) would mint it. */
async function token(userId: string, kind: "desktop" | "cli", scope: "read" | "write" = "write") {
  const raw = `${kind === "desktop" ? "sfd_" : "sfc_"}${uid("")}${uid("")}`;
  const hash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const deviceId = kind === "desktop" ? uid("dev_") : null;
  const tokenId = uid("tok_");
  const statements = [];
  if (deviceId) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at) VALUES (?, ?, 'Mac', '{}', 'secure-enclave', ?)",
      ).bind(deviceId, userId, now),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO core_cli_tokens (id, token_hash, user_id, name, scope, created_at, expires_at, kind, device_id) VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?)",
    ).bind(tokenId, hash, userId, scope, now, later, kind, deviceId),
  );
  await env.DB.batch(statements);
  return { raw, deviceId, tokenId };
}

/** The desktop app's way in (spec 42, ADR 0530): the client door's terminal socket. */
const door = (workItemId: string, runId: string, bearer?: string, upgrade = true) =>
  worker.fetch(
    new Request(`${base}/client/v1/terminal/${workItemId}/${runId}`, {
      headers: {
        ...(upgrade ? { upgrade: "websocket" } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }),
    env,
  );

/** The host connects with the URL its held call answered. */
async function host(url: string) {
  const res = await worker.fetch(
    new Request(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } }),
    env,
  );
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error("no socket");
  return end(res.webSocket);
}

describe("the web terminal relay", () => {
  it("relays the owner's terminal to watchers, takes input only from the owner, and journals each attach", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w);
    const fence = job.lease.fencingToken;

    // Nobody watching: the held call answers with nothing.
    expect(await c.terminal?.(job.jobId, { fencingToken: fence, waitMs: 0 })).toEqual({
      connect: null,
    });

    // The owner opens it while the host waits.
    const waiting = c.terminal?.(job.jobId, { fencingToken: fence, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 200));
    const owner = await view(item.workItemId, runId, w.human);
    expect(owner.mode).toBe("type");
    await owner.end.until("hello", has("hello"));
    expect(owner.end.texts[0]).toEqual({ t: "hello", mode: "type", viewers: 1, host: false });
    const answer = await waiting;
    expect(answer?.connect?.url).toMatch(
      new RegExp(
        `^wss://sf-engine\\.example/terminal/v1/jobs/${job.jobId}/host\\?ticket=[0-9a-f]{64}$`,
      ),
    );
    const url = answer?.connect?.url ?? "";
    const h = await host(url);
    await h.until("open", has("open"));
    expect(h.texts[0]).toEqual({ t: "open", size: null });
    await owner.end.until("host connected", (e) =>
      e.texts.some((m) => m.t === "viewers" && m.host === true),
    );

    // The ticket worked once.
    const again = await worker.fetch(
      new Request(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } }),
      env,
    );
    expect(again.status).toBe(401);

    // Output reaches the viewer; the owner's keys and size reach the host.
    h.ws.send(new TextEncoder().encode("\x1b[32mhello\x1b[0m"));
    await owner.end.until("output", (e) => e.bytes.length > 0);
    expect(owner.end.bytes).toEqual(["\x1b[32mhello\x1b[0m"]);
    owner.end.ws.send(JSON.stringify({ t: "input", data: "y\r" }));
    owner.end.ws.send(JSON.stringify({ t: "resize", size: { cols: 9_999, rows: 30 } }));
    await h.until("input and resize", (e) => e.texts.some((m) => m.t === "resize"));
    expect(h.texts.filter((m) => m.t !== "open")).toEqual([
      { t: "input", data: "y\r" },
      { t: "resize", size: { cols: 400, rows: 30 } },
    ]);
    h.ws.send(JSON.stringify({ t: "size", size: { cols: 400, rows: 30 } }));
    await owner.end.until("size", has("size"));

    // A member who doesn't own the runner watches: the host is asked to redraw for them.
    const sam = await member(w.orgId);
    const watcher = await view(item.workItemId, runId, sam);
    expect(watcher.mode).toBe("watch");
    await watcher.end.until("hello", has("hello"));
    expect(watcher.end.texts[0]).toMatchObject({
      t: "hello",
      mode: "watch",
      viewers: 2,
      host: true,
    });
    await h.until("redraw", has("redraw"));
    h.ws.send(new TextEncoder().encode("frame 2"));
    await watcher.end.until("output", (e) => e.bytes.includes("frame 2"));

    // A watcher that types anyway is closed by the relay, and nothing reaches the host.
    const before = h.texts.length;
    watcher.end.ws.send(JSON.stringify({ t: "input", data: "rm -rf /\r" }));
    await watcher.end.until("closed", (e) => e.closed !== null);
    expect(watcher.end.closed?.code).toBe(1008);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.texts.slice(before).filter((m) => m.t === "input")).toEqual([]);

    // The journal: both attaches, with the mode; the watcher's is closed.
    const rows = await all<{ user_id: string; mode: string; closed_at: string | null }>(
      "SELECT user_id, mode, closed_at FROM core_run_terminal_attaches WHERE run_id = ?",
      runId,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.user_id === sam.id)).toMatchObject({ mode: "watch" });
    expect(rows.find((r) => r.user_id === sam.id)?.closed_at).not.toBeNull();
    expect(rows.find((r) => r.user_id === w.userId)).toMatchObject({
      mode: "type",
      closed_at: null,
    });

    // The last viewer leaves: the host is told to stop and its socket closes.
    owner.end.ws.close(1000, "bye");
    await h.until("close", has("close"));
    await h.until("host closed", (e) => e.closed !== null);
    await waitFor("owner's attach closed", async () => {
      const row = await all<{ closed_at: string | null }>(
        "SELECT closed_at FROM core_run_terminal_attaches WHERE id = ?",
        owner.attachId,
      );
      return row[0]?.closed_at ?? null;
    });
    expect(await terminalRelay(env, job.jobId).state()).toEqual({ host: false, viewers: [] });
  });

  it("drops oversized frames and input, and tells viewers when the session ends", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w);
    const owner = await view(item.workItemId, runId, w.human);
    const answer = await c.terminal?.(job.jobId, {
      fencingToken: job.lease.fencingToken,
      waitMs: 5_000,
    });
    const h = await host(answer?.connect?.url ?? "");
    await h.until("open", has("open"));

    h.ws.send(new Uint8Array(TERMINAL_FRAME_MAX + 1));
    h.ws.send(new TextEncoder().encode("small"));
    await owner.end.until("output", (e) => e.bytes.length > 0);
    expect(owner.end.bytes).toEqual(["small"]);

    owner.end.ws.send(JSON.stringify({ t: "input", data: "x".repeat(TERMINAL_INPUT_MAX + 1) }));
    owner.end.ws.send(JSON.stringify({ t: "input", data: "ok" }));
    await h.until("input", has("input"));
    expect(h.texts.filter((m) => m.t === "input")).toEqual([{ t: "input", data: "ok" }]);

    h.ws.send(JSON.stringify({ t: "ended", reason: "the session ended" }));
    await owner.end.until("ended", has("ended"));
    await owner.end.until("viewer closed", (e) => e.closed !== null);
    expect(owner.end.closed?.code).toBe(1000);
    await h.until("host closed", (e) => e.closed !== null);
    await waitFor("attach closed", async () => {
      const row = await all<{ closed_at: string | null }>(
        "SELECT closed_at FROM core_run_terminal_attaches WHERE id = ?",
        owner.attachId,
      );
      return row[0]?.closed_at ?? null;
    });
  });

  it("refuses a ninth viewer, a stale fencing token, the wrong ticket and a runner without `terminal`", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w);
    const viewers = [];
    for (let i = 0; i < TERMINAL_MAX_VIEWERS; i++) {
      viewers.push(await view(item.workItemId, runId, w.human));
    }
    const ninth = await api().terminalAttach(item.workItemId, runId, {
      actor: w.human,
      origin: { surface: "app" },
    });
    expect(ninth).toMatchObject({ ok: false, error: { code: "conflict" } });
    // Its attach was recorded and closed at once.
    const open = await all<{ id: string }>(
      "SELECT id FROM core_run_terminal_attaches WHERE run_id = ? AND closed_at IS NULL",
      runId,
    );
    expect(open).toHaveLength(TERMINAL_MAX_VIEWERS);

    const stale = await c
      .terminal?.(job.jobId, { fencingToken: job.lease.fencingToken + 2, waitMs: 0 })
      .catch((e) => e);
    expect((stale as ChannelCallError).status).toBe(409);
    expect((stale as ChannelCallError).code).toBe("fenced");

    // A viewer ticket can't open the host socket, and viewers' sockets aren't on the public host.
    const attached = await api().terminalAttach(item.workItemId, runId, {
      actor: w.human,
      origin: { surface: "app" },
    });
    expect(attached.ok).toBe(false);
    for (const v of viewers) v.end.ws.close(1000);
    await waitFor("viewers gone", async () =>
      (await terminalRelay(env, job.jobId).state()).viewers.length === 0 ? true : null,
    );
    const again = await api().terminalAttach(item.workItemId, runId, {
      actor: w.human,
      origin: { surface: "app" },
    });
    if (!again.ok) throw new Error(again.error.message);
    const asHost = await worker.fetch(
      new Request(`${base}${again.path.replace("/view", "/host")}`, {
        headers: { upgrade: "websocket" },
      }),
      env,
    );
    expect(asHost.status).toBe(401);
    const publicView = await worker.fetch(
      new Request(`${base}${again.path}`, { headers: { upgrade: "websocket" } }),
      env,
    );
    expect(publicView.status).toBe(404);

    // A runner that doesn't declare `terminal`.
    const w2 = await world();
    const old = await running(w2, [...MANIFEST.capabilities]);
    const refused = await api().terminalAttach(old.item.workItemId, old.runId, {
      actor: w2.human,
      origin: { surface: "app" },
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("opens through the client door for a desktop token, with the same rule for who types (spec 42)", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w);
    const owner = await token(w.userId, "desktop");

    // The owner's desktop: `type`, recorded as the desktop surface with the device.
    const waiting = c.terminal?.(job.jobId, {
      fencingToken: job.lease.fencingToken,
      waitMs: 20_000,
    });
    await new Promise((r) => setTimeout(r, 200));
    const res = await door(item.workItemId, runId, owner.raw);
    expect(res.status).toBe(101);
    if (!res.webSocket) throw new Error("no socket");
    const mine = end(res.webSocket);
    await mine.until("hello", has("hello"));
    expect(mine.texts[0]).toMatchObject({ t: "hello", mode: "type", viewers: 1 });
    const h = await host((await waiting)?.connect?.url ?? "");
    await h.until("open", has("open"));
    h.ws.send(new TextEncoder().encode("live"));
    await mine.until("output", (e) => e.bytes.includes("live"));
    mine.ws.send(JSON.stringify({ t: "input", data: "ok\r" }));
    await h.until("input", (e) => e.texts.some((m) => m.t === "input"));
    const audit = await all<{ origin: string }>(
      "SELECT origin FROM core_audit WHERE operation = 'run.terminal.attach' AND actor_id = ? AND work_item_id = ?",
      w.userId,
      item.workItemId,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.origin ?? "{}")).toMatchObject({
      surface: "desktop",
      deviceId: owner.deviceId,
    });

    // Another member's desktop watches; the relay closes it if it types anyway.
    const sam = await member(w.orgId);
    const samToken = await token(sam.id, "desktop");
    const watched = await door(item.workItemId, runId, samToken.raw);
    expect(watched.status).toBe(101);
    if (!watched.webSocket) throw new Error("no socket");
    const theirs = end(watched.webSocket);
    await theirs.until("hello", has("hello"));
    expect(theirs.texts[0]).toMatchObject({ t: "hello", mode: "watch" });
    const before = h.texts.length;
    theirs.ws.send(JSON.stringify({ t: "input", data: "x" }));
    await theirs.until("closed", (e) => e.closed !== null);
    expect(theirs.closed?.code).toBe(1008);
    expect(h.texts.slice(before).filter((m) => m.t === "input")).toEqual([]);

    // Refusals come before any upgrade.
    expect((await door(item.workItemId, runId)).status).toBe(401);
    expect((await door(item.workItemId, runId, "sfd_not-a-token")).status).toBe(401);
    const cli = await token(w.userId, "cli");
    const byCli = await door(item.workItemId, runId, cli.raw);
    expect(byCli.status).toBe(403);
    expect(await byCli.json()).toMatchObject({ code: "forbidden" });
    expect((await door(item.workItemId, runId, owner.raw, false)).status).toBe(426);
    const w2 = await world();
    const outsider = await token(w2.userId, "desktop");
    expect([403, 404]).toContain((await door(item.workItemId, runId, outsider.raw)).status);
    const old = await running(w2, [...MANIFEST.capabilities]);
    const noTerminal = await door(old.item.workItemId, old.runId, outsider.raw);
    expect(noTerminal.status).toBe(503);
    expect(await noTerminal.json()).toMatchObject({ code: "unavailable" });
    mine.ws.close(1000);
  });

  it("refuses a revoked, an expired and a read-scoped token, and an ended run (spec 42)", async () => {
    const w = await world();
    const { item, runId } = await running(w);
    const at = (sql: string, ...binds: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...binds)
        .run();
    const past = new Date(Date.now() - 1_000).toISOString();

    const revoked = await token(w.userId, "desktop");
    await at("UPDATE core_cli_tokens SET revoked_at = ? WHERE id = ?", past, revoked.tokenId);
    expect((await door(item.workItemId, runId, revoked.raw)).status).toBe(401);

    const expired = await token(w.userId, "desktop");
    await at("UPDATE core_cli_tokens SET expires_at = ? WHERE id = ?", past, expired.tokenId);
    expect((await door(item.workItemId, runId, expired.raw)).status).toBe(401);

    const deviceGone = await token(w.userId, "desktop");
    await at(
      "UPDATE core_desktop_devices SET revoked_at = ? WHERE id = ?",
      past,
      deviceGone.deviceId,
    );
    expect((await door(item.workItemId, runId, deviceGone.raw)).status).toBe(401);

    // A CLI token, read or write, is never the desktop app.
    const read = await token(w.userId, "cli", "read");
    const byRead = await door(item.workItemId, runId, read.raw);
    expect(byRead.status).toBe(403);
    expect(await byRead.json()).toMatchObject({ code: "forbidden" });

    // An ended run (acceptance criterion 3): 409, before any upgrade, and nothing recorded.
    const owner = await token(w.userId, "desktop");
    await at("UPDATE core_runs SET status = 'handed_back', ended_at = ? WHERE id = ?", past, runId);
    const ended = await door(item.workItemId, runId, owner.raw);
    expect(ended.status).toBe(409);
    expect(ended.webSocket).toBeFalsy();
    expect(await ended.json()).toMatchObject({ code: "conflict" });
    expect(
      await all("SELECT id FROM core_run_terminal_attaches WHERE run_id = ?", runId),
    ).toHaveLength(0);
  });

  it("closes an open stream when the person leaves the org or the app's sign-in is revoked", async () => {
    const w = await world();
    const { job, item, runId } = await running(w);
    const relay = terminalRelay(env, job.jobId);
    const open = async (raw: string) => {
      const res = await door(item.workItemId, runId, raw);
      expect(res.status).toBe(101);
      if (!res.webSocket) throw new Error("no socket");
      const e = end(res.webSocket);
      await e.until("hello", has("hello"));
      return e;
    };

    const owner = await token(w.userId, "desktop");
    const mine = await open(owner.raw);
    const sam = await member(w.orgId);
    const samToken = await token(sam.id, "desktop");
    const theirs = await open(samToken.raw);
    const kept = await token(sam.id, "desktop");
    const theirsToo = await open(kept.raw);

    // Nothing changed: everyone stays.
    expect(await relay.recheck()).toBe(0);

    // Sam's one device sign-in is revoked: that socket closes, Sam's other one stays.
    await env.DB.prepare("UPDATE core_cli_tokens SET revoked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), samToken.tokenId)
      .run();
    expect(await relay.recheck()).toBe(1);
    await theirs.until("closed", (e) => e.closed !== null);
    expect(theirs.closed).toMatchObject({ code: 4001 });
    expect(theirs.closed?.reason).toMatch(/revoked or has expired/);
    expect(theirsToo.closed).toBeNull();

    // Sam leaves the org mid-stream: the other socket closes too, the owner's stays.
    await env.DB.prepare("DELETE FROM core_member WHERE user_id = ?").bind(sam.id).run();
    expect(await relay.recheck()).toBe(1);
    await theirsToo.until("closed", (e) => e.closed !== null);
    expect(theirsToo.closed?.reason).toMatch(/no longer a member/);
    expect(mine.closed).toBeNull();
    expect((await relay.state()).viewers).toEqual([{ userId: w.userId, mode: "type" }]);

    // An expired token is closed on the next check.
    await env.DB.prepare("UPDATE core_cli_tokens SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), owner.tokenId)
      .run();
    expect(await relay.recheck()).toBe(1);
    await mine.until("closed", (e) => e.closed !== null);
    expect((await relay.state()).viewers).toEqual([]);
  });
});

/**
 * The engine as a runner host reaches it, counting what the held calls touch: every D1 statement,
 * and every Durable Object stub they get (spec 44: an idle hold gets none).
 */
function counting() {
  const seen: Recorded[] = [];
  const objects: string[] = [];
  const counted = (ns: DurableObjectNamespace, name: string) =>
    new Proxy(ns, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "get" && typeof value === "function") {
          return (...args: unknown[]) => {
            objects.push(name);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const e = {
    ...recordingEnv(env, seen),
    PLANNING_HUB: counted(env.PLANNING_HUB as never, "PlanningHub"),
    TERMINAL_RELAY: counted(env.TERMINAL_RELAY as never, "TerminalRelay"),
  } as Env;
  const fetchVia: typeof fetch = async (input, init) => worker.fetch(new Request(input, init), e);
  return { e, seen, objects, fetchVia };
}

async function channelAs(w: World, fetchVia: typeof fetch) {
  return httpControlPlane({
    baseUrl: base,
    runnerId: w.runner.runnerId,
    key: await runnerChannelKey("test-channel-secret", w.runner.runnerId, 1),
    fetch: fetchVia,
  });
}

describe("held calls wait in the Worker, not in a Durable Object (spec 44 part A)", () => {
  it("an idle job's steer and terminal holds wake no object and read only the partial indexes", async () => {
    const w = await world();
    const { job } = await running(w, [...MANIFEST.capabilities, "terminal", "steer"]);
    const fence = job.lease.fencingToken;
    const { seen, objects, fetchVia } = counting();
    const c = await channelAs(w, fetchVia);
    const hold = 7_000;
    const started = Date.now();
    const [steers, terminal] = await Promise.all([
      c.steers?.(job.jobId, { fencingToken: fence, waitMs: hold }),
      c.terminal?.(job.jobId, { fencingToken: fence, waitMs: hold }),
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(hold - 100);
    expect(steers).toEqual({ steers: [] });
    expect(terminal).toEqual({ connect: null });
    // Not one Durable Object was touched while nothing happened.
    expect(objects).toEqual([]);
    const polls = seen.filter((s) =>
      /delivered_at IS NULL LIMIT 1|closed_at IS NULL ORDER BY opened_at/.test(s.sql),
    );
    // A poll every HELD_POLL_MS (3 s) for each hold, give or take one at either end.
    expect(polls.length).toBeGreaterThanOrEqual(4);
    expect(polls.length).toBeLessThanOrEqual(8);
    console.log(
      `spec 44 measure: ${hold} ms of both holds = ${seen.length} D1 statements (${polls.length} polls), ${objects.length} object calls`,
    );
  });

  it("a viewer who attaches mid-hold gets the host a ticket within HELD_POLL_MS + 1 s", async () => {
    const w = await world();
    const { job, item, runId } = await running(w);
    const fence = job.lease.fencingToken;
    const { objects, fetchVia } = counting();
    const c = await channelAs(w, fetchVia);
    const holding = c.terminal?.(job.jobId, { fencingToken: fence, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 500));
    const attachedAt = Date.now();
    const viewer = await view(item.workItemId, runId, w.human);
    const answer = await holding;
    expect(Date.now() - attachedAt).toBeLessThan(HELD_POLL_MS + 1_000);
    expect(answer?.connect?.url).toMatch(/ticket=[0-9a-f]{64}/);
    expect(objects).toEqual(["TerminalRelay"]);
    const h = await host(answer?.connect?.url ?? "");
    await viewer.end.until("the host joined", (e) =>
      e.texts.some((m) => m.t === "viewers" && m.host === true),
    );
    h.ws.close();
    viewer.end.ws.close();
  });

  it("closes an attach a deploy left open within one poll, and asks the relay only once", async () => {
    const w = await world();
    const { job, item, runId } = await running(w);
    const fence = job.lease.fencingToken;
    // An attach whose viewer is gone (the relay restarted): opened well before any ticket's TTL.
    const stale = uid("ta_");
    await env.DB.prepare(
      "INSERT INTO core_run_terminal_attaches (id, run_id, work_item_id, user_id, mode, opened_at) VALUES (?, ?, ?, ?, 'type', ?)",
    )
      .bind(
        stale,
        runId,
        item.workItemId,
        w.human.id,
        new Date(Date.now() - 10 * 60_000).toISOString(),
      )
      .run();
    const { objects, fetchVia } = counting();
    const c = await channelAs(w, fetchVia);
    expect(await c.terminal?.(job.jobId, { fencingToken: fence, waitMs: 7_000 })).toEqual({
      connect: null,
    });
    // Asked once, then closed, so the next polls didn't ask again; no ticket for a gone viewer.
    expect(objects).toEqual(["TerminalRelay"]);
    const row = await env.DB.prepare(
      "SELECT closed_at FROM core_run_terminal_attaches WHERE id = ?",
    )
      .bind(stale)
      .first<string | null>("closed_at");
    expect(row).not.toBeNull();
  });

  it("hands a steer over once when two takes race, and the loser keeps waiting (no 409)", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w, [
      ...MANIFEST.capabilities,
      "terminal",
      "steer",
    ]);
    const fence = job.lease.fencingToken;
    for (let round = 0; round < 3; round++) {
      await ok("run.steer", { workItemId: item.workItemId, runId, text: `race ${round}` }, w.human);
      const answers = await Promise.all([
        c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0 }),
        c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0 }),
        c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0 }),
      ]);
      // Every call answers (none refused), and the steer is in exactly one answer.
      const got = answers.flatMap((a) => a?.steers ?? []);
      expect(got.map((s) => s.text)).toEqual([`race ${round}`]);
    }
  });

  it("a held steer call whose host has gone stops polling and takes nothing", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w, [
      ...MANIFEST.capabilities,
      "terminal",
      "steer",
    ]);
    const gone = new AbortController();
    const held = c.steers?.(
      job.jobId,
      { fencingToken: job.lease.fencingToken, waitMs: 20_000 },
      gone.signal,
    );
    await new Promise((r) => setTimeout(r, 500));
    gone.abort();
    await held?.catch(() => {});
    await ok("run.steer", { workItemId: item.workItemId, runId, text: "for a live host" }, w.human);
    // Longer than a poll: an orphaned loop would have taken it by now.
    await new Promise((r) => setTimeout(r, HELD_POLL_MS + 1_500));
    const queued = await env.DB.prepare(
      "SELECT delivered_at FROM core_run_steers WHERE run_id = ? AND text = 'for a live host'",
    )
      .bind(runId)
      .first<{ delivered_at: string | null }>();
    expect(queued).toEqual({ delivered_at: null });
  });

  it("closeStale closes only attaches older than twice a ticket's life, whatever it is told", async () => {
    const w = await world();
    const { job, item, runId } = await running(w);
    const attach = async (minutesAgo: number) => {
      const id = uid("ta_");
      await env.DB.prepare(
        "INSERT INTO core_run_terminal_attaches (id, run_id, work_item_id, user_id, mode, opened_at) VALUES (?, ?, ?, ?, 'type', ?)",
      )
        .bind(
          id,
          runId,
          item.workItemId,
          w.human.id,
          new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        )
        .run();
      return id;
    };
    const fresh = await attach(1);
    const old = await attach(10);
    const closed = await ok<{ closed: number }>(
      "run.terminal.closeStale",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken, before: new Date().toISOString() },
      w.runnerActor,
    );
    expect(closed.closed).toBe(1);
    const open = await env.DB.prepare(
      "SELECT id FROM core_run_terminal_attaches WHERE run_id = ? AND closed_at IS NULL",
    )
      .bind(runId)
      .all<{ id: string }>();
    expect(open.results.map((r) => r.id)).toContain(fresh);
    expect(open.results.map((r) => r.id)).not.toContain(old);
  });

  it("an acking host gets a steer once it acks; a take nobody received is offered again", async () => {
    const w = await world();
    const { c, job, item, runId } = await running(w, [
      ...MANIFEST.capabilities,
      "terminal",
      "steer",
    ]);
    const fence = job.lease.fencingToken;
    const take = (ack: string[]) => c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0, ack });
    await ok("run.steer", { workItemId: item.workItemId, runId, text: "lost in transit" }, w.human);
    // A take whose answer never reached the host (an orphaned call): offered, not delivered.
    const lost = await take([]);
    expect(lost?.steers.map((s) => s.text)).toEqual(["lost in transit"]);
    const id = lost?.steers[0]?.id as string;
    // While the offer stands, no one else gets it.
    expect(await take([])).toEqual({ steers: [] });
    const row = () =>
      env.DB.prepare("SELECT delivered_at FROM core_run_steers WHERE id = ?")
        .bind(id)
        .first<{ delivered_at: string | null }>();
    expect(await row()).toEqual({ delivered_at: null });
    // The offer lapses (60 s): it is offered again, and delivered only when the host acks it.
    await env.DB.prepare("UPDATE core_run_steers SET offered_until = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), id)
      .run();
    expect((await take([]))?.steers.map((s) => s.id)).toEqual([id]);
    expect(await take([id])).toEqual({ steers: [] });
    expect((await row())?.delivered_at).not.toBeNull();
    // A host that doesn't ack is handed steers as before: delivered at the take.
    await ok("run.steer", { workItemId: item.workItemId, runId, text: "old host" }, w.human);
    const old = await c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0 });
    const oldRow = await env.DB.prepare("SELECT delivered_at FROM core_run_steers WHERE id = ?")
      .bind(old?.steers[0]?.id)
      .first<{ delivered_at: string | null }>();
    expect(oldRow?.delivered_at).not.toBeNull();
  });

  it("refuses a stale fencing token on both holds before any wait", async () => {
    const w = await world();
    const { job } = await running(w, [...MANIFEST.capabilities, "terminal", "steer"]);
    const { objects, fetchVia } = counting();
    const c = await channelAs(w, fetchVia);
    const started = Date.now();
    for (const call of [
      () => c.steers?.(job.jobId, { fencingToken: job.lease.fencingToken + 5, waitMs: 20_000 }),
      () => c.terminal?.(job.jobId, { fencingToken: job.lease.fencingToken + 5, waitMs: 20_000 }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "fenced" });
    }
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(objects).toEqual([]);
  });
});

describe("the job line (spec 44 part B, ADR 0592)", () => {
  /** The host's line, as sf-runner would open it with the URL the `line` call answered. */
  async function line(url: string) {
    const res = await worker.fetch(
      new Request(url.replace(/^ws/, "http"), { headers: { upgrade: "websocket" } }),
      env,
    );
    expect(res.status).toBe(101);
    if (!res.webSocket) throw new Error("no socket");
    return end(res.webSocket);
  }

  it("is declared in the heartbeat's answer, fenced, and pushes a steer and a viewer", async () => {
    const w = await world();
    const capabilities = [...MANIFEST.capabilities, "terminal", "steer", "job-line"] as const;
    const { c, job, item, runId } = await running(w, [...capabilities]);
    const beat = await c.heartbeat({
      manifest: { ...MANIFEST, capabilities: [...capabilities] },
      capacity: { max: 2, inUse: 1, accepting: true },
      activeJobs: [{ jobId: job.jobId, fencingToken: job.lease.fencingToken }],
    });
    expect(beat.engine?.capabilities).toContain("job-line");
    // A stale token is refused before any ticket is minted.
    await expect(
      c.line?.(job.jobId, { fencingToken: job.lease.fencingToken + 9 }),
    ).rejects.toMatchObject({ code: "fenced" });
    const opened = await c.line?.(job.jobId, { fencingToken: job.lease.fencingToken });
    expect(opened?.connect.url).toMatch(/\/terminal\/v1\/jobs\/.+\/line\?ticket=[0-9a-f]{64}$/);
    const l = await line(opened?.connect.url ?? "");
    // A ticket works once.
    const again = await worker.fetch(
      new Request((opened?.connect.url ?? "").replace(/^ws/, "http"), {
        headers: { upgrade: "websocket" },
      }),
      env,
    );
    expect(again.status).toBe(401);

    // A steer: pushed at once; the host's own fenced call takes it.
    await ok("run.steer", { workItemId: item.workItemId, runId, text: "add a test" }, w.human);
    await l.until("the steer push", (e) => e.texts.some((m) => m.t === "steer"));
    expect(
      await c.steers?.(job.jobId, { fencingToken: job.lease.fencingToken, waitMs: 0 }),
    ).toEqual({ steers: [expect.objectContaining({ text: "add a test" })] });

    // A viewer with no host connected: pushed; the host's call answers a ticket at once.
    const viewer = await view(item.workItemId, runId, w.human);
    await l.until("the viewer push", (e) => e.texts.some((m) => m.t === "viewer"));
    const t = await c.terminal?.(job.jobId, { fencingToken: job.lease.fencingToken, waitMs: 0 });
    expect(t?.connect?.url).toMatch(/ticket=/);
    viewer.end.ws.close();

    // A host ticket isn't a line ticket, and a line ticket isn't a host one.
    const hostTicket = await env.TERMINAL_RELAY.get(
      env.TERMINAL_RELAY.idFromName(job.jobId),
    ).lineTicket();
    const swapped = await worker.fetch(
      new Request(`${base}/terminal/v1/jobs/${job.jobId}/host?ticket=${hostTicket}`, {
        headers: { upgrade: "websocket" },
      }),
      env,
    );
    expect(swapped.status).toBe(401);
    // Another runner can't open this job's line.
    const other = await world();
    const stranger = httpControlPlane({
      baseUrl: base,
      runnerId: other.runner.runnerId,
      key: await runnerChannelKey("test-channel-secret", other.runner.runnerId, 1),
      fetch: engineFetch,
    });
    await expect(
      stranger.line?.(job.jobId, { fencingToken: job.lease.fencingToken }),
    ).rejects.toMatchObject({ status: 403 });

    // A second line replaces the first.
    const second = await line(
      (await c.line?.(job.jobId, { fencingToken: job.lease.fencingToken }))?.connect.url ?? "",
    );
    await l.until("the old line closed", (e) => e.closed !== null);
    expect(l.closed?.code).toBe(4000);
    second.ws.close();
  });

  it("pushes planning changes to the planning job's line", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Plan on a line" },
      w.human,
    );
    await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
    const c = httpControlPlane({
      baseUrl: base,
      runnerId: w.runner.runnerId,
      key: await runnerChannelKey("test-channel-secret", w.runner.runnerId, 1),
      fetch: engineFetch,
    });
    let job: Job | null = null;
    for (let i = 0; i < 200 && !job; i++) {
      const claimed = (
        await c.claim({
          claimId: uid("claim-"),
          manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities, "job-line"] },
          capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
        })
      ).job;
      if (claimed?.stage === "planning") job = claimed;
      else if (!claimed) await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no planning job");
    const opened = await c.line?.(job.jobId, { fencingToken: job.lease.fencingToken });
    const l = await line(opened?.connect.url ?? "");
    await ok("chat.send", { workItemId: item.workItemId, text: "Use UTC" }, w.human);
    await l.until("the planning push", (e) => e.texts.some((m) => m.t === "planning"));
    l.ws.close();
  });
});
