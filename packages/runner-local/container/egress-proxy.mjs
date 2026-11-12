// The job's egress proxy (ADR 0430). It runs in its own container from the agent image, on the
// job's internal network (where the agent is, with no route out) and on the default bridge (which
// has one). The agent's HTTPS_PROXY / HTTP_PROXY point here. It allows `CONNECT host:port` and
// absolute-URI HTTP requests only to the hosts on its allowlist, on ports 443 and 80 unless an
// entry names its own port, and answers everything else 403. One JSON line per decision goes to
// stdout (`docker logs`), which the runner keeps as the run's `egress-log`.
//
//   node egress-proxy.mjs --port 3128 --allow registry.npmjs.org,*.github.com,host:8080
//
// An allowed name is resolved once, here, and the connection goes to that address (no second
// lookup a rebinding name could change). A name that resolves to a private, loopback, link-local,
// CGNAT (Tailscale), benchmarking (OrbStack) or otherwise non-public address, or to the container
// runtime's host gateway, is refused: an allowlisted name must never open a path to the host or the
// owner's network (fifth review). `--private-ok host:port,...` exempts exact entries: the runner's
// own tests only, never a project's allowlist.
//
// Self-contained (Node built-ins only): it is copied into the image as is. `hostAllowed` must agree
// with runner-local's `src/container/egress.ts`; a test checks both on the same cases.
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request } from "node:http";
import { BlockList, connect, isIP } from "node:net";
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

/** Addresses no allowlisted name may reach (RFC 6890 special-purpose, and more). */
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network" (OrbStack's host is 0.250.250.254)
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT: Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12], // Docker's bridges
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking: OrbStack's networks
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // unique local (Tailscale's IPv6 too)
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NOT_PUBLIC.addSubnet(net, prefix, "ipv6");
}

/** Whether `address` (an IP) is one no allowlisted name may reach. */
export function notPublic(address, extra = []) {
  let a = String(address)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  else if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // mapped, hex form
  const family = isIP(a);
  if (!family) return true;
  if (extra.includes(a)) return true;
  return NOT_PUBLIC.check(a, family === 4 ? "ipv4" : "ipv6");
}

/** The runtime's names for the host; their addresses are refused too (resolved at start). */
const HOST_GATEWAY_NAMES = [
  "host.docker.internal",
  "gateway.docker.internal",
  "host.internal",
  "host.orb.internal",
];

/**
 * Resolves `host` once and returns the address to connect to, or why not. `privateOk` holds exact
 * `host:port` entries the filter lets through (the runner's own tests).
 */
async function resolveTarget(host, port, { lookup, gateways, privateOk }) {
  const name = String(host).replace(/^\[|\]$/g, "");
  const exempt = privateOk.includes(`${name.toLowerCase()}:${port}`);
  let addresses;
  if (isIP(name)) addresses = [name];
  else {
    try {
      addresses = (await lookup(name, { all: true, verbatim: true })).map((a) => a.address);
    } catch (error) {
      return { error: `can't resolve ${name}: ${error.code ?? error.message}` };
    }
  }
  if (addresses.length === 0) return { error: `can't resolve ${name}` };
  if (!exempt) {
    const bad = addresses.find((a) => notPublic(a, gateways));
    if (bad) return { error: `${name} resolves to ${bad}, not a public address` };
  }
  // Every address passed: connect to an IPv4 one where there is one (a container's IPv6 often has no
  // route), never a fresh lookup.
  return { address: addresses.find((a) => isIP(a) === 4) ?? addresses[0] };
}

/** `host:port` from a CONNECT target. */
function splitTarget(target) {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target ?? "");
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

export function createEgressProxy({
  allow,
  log = (line) => console.log(JSON.stringify(line)),
  lookup = dnsLookup,
  privateOk = [],
}) {
  const record = (method, host, port, allowed, reason) =>
    log({
      time: new Date().toISOString(),
      method,
      host,
      port,
      allowed,
      ...(reason ? { reason } : {}),
    });
  const ok = privateOk.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  // The runtime's host gateway, wherever it is: resolved once, refused whatever its range.
  const gateways = [];
  const gatewaysReady = Promise.all(
    HOST_GATEWAY_NAMES.map((n) =>
      lookup(n, { all: true, verbatim: true }).then(
        (as) => {
          for (const a of as) gateways.push(String(a.address).toLowerCase());
        },
        () => {},
      ),
    ),
  );
  const target = async (host, port) => {
    await gatewaysReady;
    return resolveTarget(host, port, { lookup, gateways, privateOk: ok });
  };

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
    const listed = url.protocol === "http:" && hostAllowed(url.hostname, port, allow);
    if (!listed) {
      record(req.method ?? "GET", url.hostname, port, false);
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end(`blocked by the software factory's egress allowlist: ${url.hostname}:${port}\n`);
      return;
    }
    req.pause();
    void target(url.hostname, port).then(({ address, error }) => {
      record(req.method ?? "GET", url.hostname, port, !error, error);
      if (error) {
        res
          .writeHead(403, { "content-type": "text/plain" })
          .end(`blocked by the software factory's egress proxy: ${error}\n`);
        return;
      }
      forward(address);
    });
    const forward = (address) => {
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const upstream = request(
        {
          host: address,
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
      req.resume();
    };
  });

  server.on("connect", (req, socket, head) => {
    const t = splitTarget(req.url);
    const listed = !!t && hostAllowed(t.host, t.port, allow);
    if (!t || !listed) {
      record("CONNECT", t?.host ?? String(req.url), t?.port ?? 0, false);
      socket.end(
        "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nblocked by the software factory's egress allowlist\n",
      );
      return;
    }
    socket.on("error", () => {});
    void target(t.host, t.port).then(({ address, error }) => {
      record("CONNECT", t.host, t.port, !error, error);
      if (error) {
        socket.end(
          `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nblocked by the software factory's egress proxy: ${error}\n`,
        );
        return;
      }
      // The address resolved above, never the name again.
      const upstream = connect(t.port, address, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () =>
        socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n"),
      );
      socket.on("error", () => upstream.destroy());
    });
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
  const privateOk = (arg("--private-ok") ?? "").split(",").filter(Boolean);
  const server = createEgressProxy({ allow, privateOk });
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
