// Shared by the deploy scripts: find every deployable Worker in the repo, read its wrangler.jsonc,
// and work out what it binds to and in what order the Workers deploy.
//
// Runs on Node 24 with type stripping (`node scripts/deploy/<script>.ts`), so this file uses only
// erasable TypeScript and no dependencies.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Workspace folders that may hold a deployable Worker (a folder with a wrangler.jsonc). */
const WORKSPACE_GLOBS = ["apps", "packages", "local"];

/** The parts of a wrangler config the deploy scripts read. Everything else is passed through. */
export interface WranglerConfig {
  name: string;
  d1_databases?: { binding: string; database_name?: string; migrations_dir?: string }[];
  kv_namespaces?: { binding: string; id?: string }[];
  r2_buckets?: { binding: string; bucket_name?: string }[];
  queues?: {
    producers?: { binding: string; queue: string }[];
    consumers?: { queue: string; dead_letter_queue?: string }[];
  };
  services?: { binding: string; service: string }[];
}

export interface Worker {
  /** Repo-relative folder, e.g. `apps/app`. */
  dir: string;
  config: WranglerConfig;
}

/** JSONC → JSON: drops // and /* comments outside strings, and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Every folder under apps/, packages/ and local/ with a wrangler.jsonc, in deploy order. */
export function findWorkers(base = root): Worker[] {
  const workers: Worker[] = [];
  for (const group of WORKSPACE_GLOBS) {
    const groupDir = join(base, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(groupDir, entry.name, "wrangler.jsonc");
      if (!existsSync(file)) continue;
      const config = parseJsonc(readFileSync(file, "utf8")) as WranglerConfig;
      if (!config.name) throw new Error(`${file} has no "name"`);
      workers.push({ dir: `${group}/${entry.name}`, config });
    }
  }
  return deployOrder(workers);
}

/**
 * Workers sorted so a service binding's target deploys before the Worker that binds to it.
 * Bindings to Workers outside the repo are ignored. A cycle is an error.
 */
export function deployOrder(workers: Worker[]): Worker[] {
  const byName = new Map(workers.map((w) => [w.config.name, w]));
  const sorted: Worker[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (worker: Worker, path: string[]) => {
    const name = worker.config.name;
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new Error(`service bindings form a cycle: ${[...path, name].join(" → ")}`);
    }
    state.set(name, "visiting");
    for (const { service } of worker.config.services ?? []) {
      const target = byName.get(service);
      if (target && target !== worker) visit(target, [...path, name]);
    }
    state.set(name, "done");
    sorted.push(worker);
  };
  for (const worker of [...workers].sort((a, b) => a.dir.localeCompare(b.dir))) visit(worker, []);
  return sorted;
}

export interface Resources {
  /** D1 database names. */
  d1: string[];
  /** R2 bucket names. */
  r2: string[];
  /** Queue names: producers, consumers and dead-letter queues. */
  queues: string[];
  /** KV bindings without an id, which wrangler provisions on deploy (`<worker>.<binding>`). */
  kvAutoProvisioned: string[];
}

/** The named resources every Worker binds to, deduplicated. */
export function resourcesOf(workers: Worker[]): Resources {
  const d1 = new Set<string>();
  const r2 = new Set<string>();
  const queues = new Set<string>();
  const kv: string[] = [];
  for (const { config } of workers) {
    for (const db of config.d1_databases ?? []) {
      if (!db.database_name)
        throw new Error(`${config.name}: D1 binding ${db.binding} has no database_name`);
      d1.add(db.database_name);
    }
    for (const bucket of config.r2_buckets ?? []) {
      if (!bucket.bucket_name)
        throw new Error(`${config.name}: R2 binding ${bucket.binding} has no bucket_name`);
      r2.add(bucket.bucket_name);
    }
    for (const p of config.queues?.producers ?? []) queues.add(p.queue);
    for (const c of config.queues?.consumers ?? []) {
      queues.add(c.queue);
      if (c.dead_letter_queue) queues.add(c.dead_letter_queue);
    }
    for (const ns of config.kv_namespaces ?? []) {
      if (!ns.id) kv.push(`${config.name}.${ns.binding}`);
    }
  }
  return {
    d1: [...d1].sort(),
    r2: [...r2].sort(),
    queues: [...queues].sort(),
    kvAutoProvisioned: kv,
  };
}

/**
 * One migration run per D1 database: the first Worker (in deploy order) that sets
 * `migrations_dir` for it. Databases with no migrations_dir anywhere are skipped.
 */
export function migrationsOf(workers: Worker[]): { database: string; dir: string }[] {
  const seen = new Map<string, string>();
  for (const { dir, config } of workers) {
    for (const db of config.d1_databases ?? []) {
      if (db.database_name && db.migrations_dir && !seen.has(db.database_name)) {
        seen.set(db.database_name, dir);
      }
    }
  }
  return [...seen].map(([database, dir]) => ({ database, dir }));
}

/** Runs wrangler from a Worker's folder (each deployable package has wrangler as a devDependency). */
export function wrangler(
  dir: string,
  args: string[],
  opts: { capture?: boolean; allowFailure?: boolean } = {},
): { ok: boolean; stdout: string } {
  if (!opts.capture) console.log(`\n$ (${dir}) wrangler ${args.join(" ")}`);
  try {
    const stdout = execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: join(root, dir),
      stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      encoding: "utf8",
    });
    return { ok: true, stdout: stdout ?? "" };
  } catch (error) {
    if (!opts.allowFailure) throw error;
    return { ok: false, stdout: "" };
  }
}
