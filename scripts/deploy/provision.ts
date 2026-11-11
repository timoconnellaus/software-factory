// Creates the Cloudflare resources the Workers bind to, when they are missing. Idempotent: every
// step looks before it creates, so it is safe on every deploy.
//
//   D1 databases  by database_name (created here so migrations can run before the first deploy)
//   R2 buckets    by bucket_name
//   Queues        producers, consumers and dead-letter queues (wrangler never creates these)
//   KV            nothing to do: a binding with no `id` is provisioned by `wrangler deploy`
//
// Uses CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment (or a wrangler login).
//
// Usage: node scripts/deploy/provision.ts [--dry-run]
import { findWorkers, resourcesOf, wrangler } from "./lib.ts";

const dryRun = process.argv.includes("--dry-run");
const workers = findWorkers();
if (workers.length === 0) {
  console.log("No Workers with a wrangler.jsonc: nothing to provision.");
  process.exit(0);
}
// Any Worker's folder will do for account-level commands.
const cwd = workers[0].dir;
const resources = resourcesOf(workers);

console.log(`Workers: ${workers.map((w) => `${w.config.name} (${w.dir})`).join(", ")}`);
console.log(`D1: ${resources.d1.join(", ") || "none"}`);
console.log(`R2: ${resources.r2.join(", ") || "none"}`);
console.log(`Queues: ${resources.queues.join(", ") || "none"}`);
console.log(
  `KV (provisioned by wrangler deploy): ${resources.kvAutoProvisioned.join(", ") || "none"}`,
);

function ensure(kind: string, name: string, exists: () => boolean, create: string[]) {
  if (exists()) {
    console.log(`✓ ${kind} ${name} exists`);
    return;
  }
  if (dryRun) {
    console.log(`+ ${kind} ${name} would be created (dry run)`);
    return;
  }
  console.log(`+ creating ${kind} ${name}`);
  wrangler(cwd, create);
}

if (resources.d1.length > 0) {
  const list = wrangler(cwd, ["d1", "list", "--json"], { capture: true });
  const existing = new Set((JSON.parse(list.stdout) as { name: string }[]).map((db) => db.name));
  for (const name of resources.d1) {
    ensure("D1 database", name, () => existing.has(name), ["d1", "create", name]);
  }
}

for (const name of resources.r2) {
  ensure(
    "R2 bucket",
    name,
    () => wrangler(cwd, ["r2", "bucket", "info", name], { capture: true, allowFailure: true }).ok,
    ["r2", "bucket", "create", name],
  );
}

for (const name of resources.queues) {
  ensure(
    "queue",
    name,
    () => wrangler(cwd, ["queues", "info", name], { capture: true, allowFailure: true }).ok,
    ["queues", "create", name],
  );
}

console.log("\nProvisioning done.");
