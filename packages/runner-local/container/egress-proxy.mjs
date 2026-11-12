// The job's egress proxy (ADR 0430). It runs in its own container from the agent image, on the
// job's internal network (where the agent is, with no route out) and on the default bridge (which
// has one). The agent's HTTPS_PROXY / HTTP_PROXY point here. It allows `CONNECT host:port` and
// absolute-URI HTTP requests only to the hosts on its allowlist, on ports 443 and 80 unless an
// entry names its own port, and answers everything else 403. One JSON line per decision goes to
// stdout (`docker logs`), which the runner keeps as the run's `egress-log`.
//
//   node egress-proxy.mjs --port 3128 --allow registry.npmjs.org,*.github.com,host:8080
//
// Self-contained (Node built-ins only): it is copied into the image as is. `hostAllowed` must agree
// with runner-local's `src/container/egress.ts`; a test checks both on the same cases.
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT_PORTS = [80, 443];

/** Whether `host:port` is on the allowlist (exact names, `*.suffix` for subdomains, `host:port`). */
export function hostAllowed(host, port, allow) {
  const name = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  for (const raw of allow) {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) continue;
    const m = /^(.*?)(?::(\d+))?$/.exec(entry);
    const pattern = m?.[1] ?? "";
    const ports = m?.[2] ? [Number(m[2])] : DEFAULT_PORTS;
    if (!ports.includes(Number(port))) continue;
    if (pattern.startsWith("*.")) {
      if (name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

/** `host:port` from a CONNECT target. */
function splitTarget(target) {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target ?? "");
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

export function createEgressProxy({ allow, log = (line) => console.log(JSON.stringify(line)) }) {
  const record = (method, host, port, allowed) =>
    log({ time: new Date().toISOString(), method, host, port, allowed });

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res
        .writeHead(400, { "content-type": "text/plain" })
        .end("egress proxy: absolute URL required\n");
      return;
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const allowed = url.protocol === "http:" && hostAllowed(url.hostname, port, allow);
    record(req.method ?? "GET", url.hostname, port, allowed);
    if (!allowed) {
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end(`blocked by the software factory's egress allowlist: ${url.hostname}:${port}\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = request(
      {
        host: url.hostname,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`egress proxy: ${error.code ?? error.message}\n`);
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, socket, head) => {
    const target = splitTarget(req.url);
    const allowed = !!target && hostAllowed(target.host, target.port, allow);
    record("CONNECT", target?.host ?? String(req.url), target?.port ?? 0, allowed);
    if (!target || !allowed) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nblocked by the software factory's egress allowlist\n",
      );
      return;
    }
    const upstream = connect(target.port, target.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n"));
    socket.on("error", () => upstream.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(arg("--port") ?? 3128);
  const allow = (arg("--allow") ?? "").split(",").filter(Boolean);
  const server = createEgressProxy({ allow });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ time: new Date().toISOString(), listening: port, allow }));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
