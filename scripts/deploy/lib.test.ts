// node --test scripts/deploy/
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deployOrder,
  findWorkers,
  migrationsOf,
  parseJsonc,
  resourcesOf,
  type Worker,
} from "./lib.ts";

const worker = (dir: string, config: Worker["config"]): Worker => ({ dir, config });

test("parseJsonc drops comments and trailing commas but keeps strings", () => {
  const text = `// top\n{ "a": "x // not a comment", /* b */ "b": [1, 2,], "c": "q\\"/*" ,}`;
  assert.deepEqual(parseJsonc(text), { a: "x // not a comment", b: [1, 2], c: 'q"/*' });
});

test("deployOrder puts service-binding targets first and ignores outside services", () => {
  const app = worker("apps/app", {
    name: "sf-app",
    services: [
      { binding: "ENGINE", service: "sf-engine" },
      { binding: "X", service: "elsewhere" },
    ],
  });
  const engine = worker("apps/engine", { name: "sf-engine" });
  assert.deepEqual(
    deployOrder([app, engine]).map((w) => w.config.name),
    ["sf-engine", "sf-app"],
  );
});

test("deployOrder rejects a cycle", () => {
  const a = worker("apps/a", { name: "a", services: [{ binding: "B", service: "b" }] });
  const b = worker("apps/b", { name: "b", services: [{ binding: "A", service: "a" }] });
  assert.throws(() => deployOrder([a, b]), /cycle/);
});

test("resourcesOf and migrationsOf deduplicate across Workers", () => {
  const db = { binding: "DB", database_name: "sf", migrations_dir: "../../packages/db/migrations" };
  const workers = [
    worker("apps/engine", {
      name: "sf-engine",
      d1_databases: [db],
      queues: { consumers: [{ queue: "sf-events", dead_letter_queue: "sf-events-dlq" }] },
    }),
    worker("apps/app", {
      name: "sf-app",
      d1_databases: [db],
      r2_buckets: [{ binding: "BLOBS", bucket_name: "sf-blobs" }],
      kv_namespaces: [{ binding: "CACHE" }, { binding: "PINNED", id: "abc" }],
      queues: { producers: [{ binding: "EVENTS", queue: "sf-events" }] },
    }),
  ];
  assert.deepEqual(resourcesOf(workers), {
    d1: ["sf"],
    r2: ["sf-blobs"],
    queues: ["sf-events", "sf-events-dlq"],
    kvAutoProvisioned: ["sf-app.CACHE"],
  });
  assert.deepEqual(migrationsOf(workers), [{ database: "sf", dir: "apps/engine" }]);
});

test("findWorkers finds every wrangler.jsonc under apps/, packages/ and local/", () => {
  const base = mkdtempSync(join(tmpdir(), "sf-deploy-"));
  for (const [dir, name] of [
    ["apps/app", "sf-app"],
    ["packages/connector-webhook", "sf-conn"],
    ["packages/core", null],
  ] as const) {
    mkdirSync(join(base, dir), { recursive: true });
    if (name) writeFileSync(join(base, dir, "wrangler.jsonc"), `// c\n{ "name": "${name}", }`);
  }
  assert.deepEqual(
    findWorkers(base).map((w) => w.dir),
    ["apps/app", "packages/connector-webhook"],
  );
});

test("the repo's own Workers include sf-app and sf-engine", () => {
  const names = findWorkers().map((w) => w.config.name);
  assert.ok(names.includes("sf-app"));
  assert.ok(names.includes("sf-engine"));
});
