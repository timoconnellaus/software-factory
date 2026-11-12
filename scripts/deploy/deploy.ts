// Deploys every Worker in the repo from source: provisions missing resources, applies D1
// migrations, then runs `wrangler deploy` for each Worker, service-binding targets first.
//
// Steps can be run alone, which is what the deploy workflow does so each shows as its own step:
//
//   node scripts/deploy/deploy.ts list        print the Workers and their deploy order
//   node scripts/deploy/deploy.ts migrate     apply D1 migrations (--remote)
//   node scripts/deploy/deploy.ts workers     wrangler deploy, every Worker
//   node scripts/deploy/deploy.ts             provision + migrate + workers
//
// Uses CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment (or a wrangler login).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { deployArgs, findWorkers, migrationsOf, root, runnerSha, wrangler } from "./lib.ts";

const step = process.argv[2] ?? "all";
const workers = findWorkers();

function list() {
  console.log("Deploy order:");
  for (const [i, w] of workers.entries()) console.log(`  ${i + 1}. ${w.config.name} (${w.dir})`);
  const migrations = migrationsOf(workers);
  console.log("D1 migrations:");
  if (migrations.length === 0) console.log("  none");
  for (const m of migrations) console.log(`  ${m.database} (from ${m.dir})`);
}

function migrate() {
  const migrations = migrationsOf(workers);
  if (migrations.length === 0)
    console.log("No D1 databases with a migrations_dir: nothing to apply.");
  for (const { database, dir } of migrations) {
    wrangler(dir, ["d1", "migrations", "apply", database, "--remote"]);
  }
}

/** The commit being deployed (the deploy workflow checks out the commit CI passed on). */
function deployedSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function deployWorkers() {
  const sha = deployedSha();
  console.log(`Deploying commit ${sha ?? "(unknown)"}`);
  // What runners are asked to run (ADR 0520). Unknown (a shallow clone): they get `sha` itself.
  const runner = sha ? runnerSha(sha) : null;
  console.log(`Runner code at ${runner ?? `(unknown from git history; runners get ${sha})`}`);
  for (const { dir, config } of workers) {
    wrangler(dir, ["deploy", ...deployArgs(config, sha, runner)]);
  }
}

switch (step) {
  case "list":
    list();
    break;
  case "migrate":
    migrate();
    break;
  case "workers":
    deployWorkers();
    break;
  case "all":
    list();
    execFileSync(process.execPath, [join(root, "scripts/deploy/provision.ts")], {
      stdio: "inherit",
    });
    migrate();
    deployWorkers();
    break;
  default:
    console.error(`Unknown step "${step}". Use list, migrate, workers, or nothing for all.`);
    process.exit(1);
}
