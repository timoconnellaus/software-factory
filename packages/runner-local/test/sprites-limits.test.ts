// The sprites runner's defences against a provider (or a sprite) that misbehaves (ADR 0480): the
// terminal bridge's reattach budget, exec framing without an exit, output caps, the upload's hash
// check and the mirror's file and byte caps. Against small WebSocket servers on localhost and the
// fake Sprites API.
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createMirror, runTtyBridge, scriptArgv, spritesApi, UPLOAD } from "../src/index.ts";
import { acceptWebSocket, fakeSpritesApi, type ServerSocket } from "../src/testing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sf-spr-lim-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A WebSocket server that does `onSocket` with every connection. */
async function wsServer(onSocket: (ws: ServerSocket, path: string) => void) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new Set<import("node:stream").Duplex>();
  let connections = 0;
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    connections++;
    onSocket(acceptWebSocket(req, socket), req.url ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    http: `http://127.0.0.1:${port}`,
    connections: () => connections,
  };
}

const io = () => {
  let out = "";
  return {
    stdin: new PassThrough(),
    stdout: Object.assign(
      new Writable({
        write(chunk, _e, done) {
          out += chunk.toString();
          done();
        },
      }),
      { columns: 80, rows: 24 },
    ),
    out: () => out,
  };
};

describe("the terminal bridge's limits", { timeout: 20_000 }, () => {
  it("gives up after its reattach budget when the server accepts and drops every time", async () => {
    const root = await scratch();
    const tokenFile = join(root, "t");
    await writeFile(tokenFile, "tok");
    const server = await wsServer((ws) => {
      ws.send(JSON.stringify({ type: "session_info", session_id: "s1", tty: true }));
      ws.send(Buffer.from("replayed output"));
      setTimeout(() => ws.close(1011, "gone again"), 5);
    });
    const term = io();
    const code = await runTtyBridge(
      { url: `${server.url}/exec`, attachBase: `${server.url}/exec`, tokenFile, reattach: 5 },
      { stdin: term.stdin, stdout: term.stdout, backoffMs: 1 },
    );
    expect(code).toBe(1);
    expect(server.connections()).toBe(6);
    expect(term.out()).toMatch(/gave up after 5 reattaches/);
  });

  it("gives up when one outage outlasts its limit", async () => {
    const root = await scratch();
    const tokenFile = join(root, "t");
    await writeFile(tokenFile, "tok");
    let first = true;
    const server = await wsServer((ws) => {
      if (first) {
        first = false;
        ws.send(JSON.stringify({ type: "session_info", session_id: "s1", tty: true }));
      }
      setTimeout(() => ws.close(1011), 5);
    });
    const term = io();
    const code = await runTtyBridge(
      { url: `${server.url}/exec`, attachBase: `${server.url}/exec`, tokenFile, giveUpMs: 150 },
      { stdin: term.stdin, stdout: term.stdout, backoffMs: 20 },
    );
    expect(code).toBe(1);
    expect(term.out()).toMatch(/gave up after \d+ s without it/);
  });

  it("shows terminal output sent as text, and reads a missing exit code as a failure", async () => {
    const root = await scratch();
    const tokenFile = join(root, "t");
    await writeFile(tokenFile, "tok");
    const server = await wsServer((ws) => {
      ws.send("plain text output");
      ws.send(JSON.stringify({ type: "port_opened", port: 3000 }));
      ws.send(JSON.stringify({ type: "exit" }));
    });
    const term = io();
    const code = await runTtyBridge(
      { url: `${server.url}/exec`, attachBase: `${server.url}/exec`, tokenFile },
      { stdin: term.stdin, stdout: term.stdout },
    );
    expect(code).toBe(1);
    expect(term.out()).toContain("plain text output");
    expect(term.out()).not.toContain("port_opened");
  });
});

describe("exec's framing and caps", { timeout: 20_000 }, () => {
  it("fails an exec that closes cleanly without an exit code", async () => {
    const server = await wsServer((ws) => {
      ws.onMessage((data) => {
        if (data[0] === 4) {
          ws.send(Buffer.concat([Buffer.from([1]), Buffer.from("half")]));
          ws.close(1000);
        }
      });
    });
    const api = spritesApi({ apiUrl: server.http, token: "t" });
    await expect(api.exec("s", ["true"])).rejects.toThrow(/closed 1000 with no exit code/);
  });

  it("fails an exec whose output passes its cap", async () => {
    const server = await wsServer((ws) => {
      ws.onMessage((data) => {
        if (data[0] === 4) {
          ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(5000, 97)]));
          ws.send(Buffer.from([3, 0]));
        }
      });
    });
    const api = spritesApi({ apiUrl: server.http, token: "t" });
    await expect(api.exec("s", ["cat"], { maxStdout: 1000 })).rejects.toThrow(/over 1000 bytes/);
  });

  it("refuses an upload whose bytes don't match their hash, and streams stdout to a file", async () => {
    const root = await scratch();
    const fake = await fakeSpritesApi(join(root, "cloud"));
    cleanups.push(fake.close);
    const api = spritesApi({ apiUrl: fake.url, token: fake.token });
    await api.create("sf-x", { cpus: 1, memoryMb: 1024, storageGb: 10 });
    const tar = join(root, "a.tar");
    await writeFile(tar, "not really a tar");
    const r = await api.exec("sf-x", scriptArgv(UPLOAD, ["/", "0".repeat(64), "/job"]), {
      stdinFile: tar,
      env: { SF_SUDO: "" },
    });
    expect(r.code).toBe(65);
    expect(r.stderr.toString()).toMatch(/arrived as [0-9a-f]{64}, not 0{64}/);
    const out = join(root, "out");
    const big = await api.exec(
      "sf-x",
      ["sh", "-c", "set -eu\n# sf-sprite:yes\nhead -c 300000 /dev/zero"],
      {
        stdoutFile: out,
        maxStdout: 1 << 20,
      },
    );
    expect(big.code).toBe(0);
    expect(big.stdout.length).toBe(0);
    expect((await readFile(out)).length).toBe(300_000);
  });
});

describe("the mirror's caps", () => {
  it("mirrors at most maxFiles files and maxTotal bytes", async () => {
    const root = await scratch();
    const fake = await fakeSpritesApi(join(root, "cloud"));
    cleanups.push(fake.close);
    const api = spritesApi({ apiUrl: fake.url, token: fake.token });
    await api.create("sf-m", { cpus: 1, memoryMb: 1024, storageGb: 10 });
    const sprite = fake.sprites.get("sf-m");
    if (!sprite) throw new Error("no sprite");
    const host = join(root, "host");
    const files = ["a", "b", "c"].map((n) => join(host, n));
    for (const f of files) {
      await import("node:fs/promises").then(async (fs) => {
        await fs.mkdir(join(sprite.root, host), { recursive: true });
        await fs.writeFile(join(sprite.root, f), "x".repeat(1000));
      });
    }
    const mirror = createMirror({
      api,
      sandbox: "sf-m",
      files: () => files,
      maxFiles: 2,
      maxTotal: 1500,
    });
    await mirror.pull();
    await mirror.pull();
    const sizes = await Promise.all(
      files.map((f) =>
        readFile(f).then(
          (b) => b.length,
          () => -1,
        ),
      ),
    );
    expect(sizes[2]).toBe(-1);
    expect((sizes[0] ?? 0) + (sizes[1] ?? 0)).toBe(1500);
  });
});
