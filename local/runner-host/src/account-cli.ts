// `sf-runner account …` (ADR 0410, spec 32): Claude accounts on this host. Adding and removing is
// only ever done here; the dashboard can only pick among the names.
//
//   sf-runner account list
//   sf-runner account add <name>                    a login: runs `claude` in the account's own
//                                                   config dir so you log in there (--no-login
//                                                   to do that later)
//   sf-runner account add <name> --token-stdin      a token: `claude setup-token`'s OAuth token
//                     [--oauth | --api-key]         or an API key, piped in (kept 0600, here)
//   sf-runner account use <name>                    new jobs use it; running jobs keep theirs
//   sf-runner account remove <name>
import { parseArgs } from "node:util";
import {
  type AccountPaths,
  accountsInUse,
  addLoginAccount,
  addTokenAccount,
  listAccounts,
  loggedInAs,
  loginEnv,
  removeAccount,
  useAccount,
} from "./accounts.ts";

export interface AccountCliDeps {
  paths: AccountPaths;
  runsDir: string;
  /** The jobs a running host holds (null: unknown, so treat every run dir as live). */
  liveJobs: () => Promise<Set<string> | null>;
  allRuns: () => Promise<string[]>;
  readStdin: () => Promise<string>;
  /** Runs `claude` interactively with this environment; resolves with its exit code. */
  runClaude: (env: NodeJS.ProcessEnv) => Promise<number | null>;
  log: (line: string) => void;
}

export const ACCOUNT_USAGE =
  "usage: sf-runner account list | add <name> [--token-stdin [--oauth|--api-key]] [--no-login] | use <name> | remove <name>";

export async function accountCommand(args: string[], deps: AccountCliDeps): Promise<number> {
  const [verb, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "token-stdin": { type: "boolean" },
      oauth: { type: "boolean" },
      "api-key": { type: "boolean" },
      "no-login": { type: "boolean" },
    },
  });
  const name = positionals[0];
  const log = deps.log;
  switch (verb) {
    case undefined:
    case "list": {
      for (const a of await listAccounts(deps.paths)) {
        const kind =
          a.kind === "token" ? `token (${a.tokenEnv})` : a.kind === "login" ? "login" : "default";
        const who = a.kind === "login" ? await loggedInAs(a.configDir) : null;
        log(
          `${a.active ? "*" : " "} ${a.name.padEnd(16)} ${kind}${who ? `, ${who}` : ""}  ${a.configDir}`,
        );
        if (a.limit) log(`    hit a usage limit ${a.limit.at}: ${a.limit.message}`);
      }
      log("* = active: new jobs use it. Switch with sf-runner account use <name>, or in Setup.");
      return 0;
    }
    case "add": {
      if (!name) break;
      if (values["token-stdin"]) {
        if (values.oauth && values["api-key"]) {
          log("--oauth or --api-key, not both");
          return 2;
        }
        const token = await deps.readStdin();
        const added = await addTokenAccount(deps.paths, name, token, {
          ...(values.oauth ? { env: "CLAUDE_CODE_OAUTH_TOKEN" as const } : {}),
          ...(values["api-key"] ? { env: "ANTHROPIC_API_KEY" as const } : {}),
        });
        log(
          `Added token account "${name}" (${added.token?.env}); the token is in ${added.token?.file} (0600) and never leaves this machine.`,
        );
        log(`Use it for new jobs: sf-runner account use ${name}`);
        return 0;
      }
      const added = await addLoginAccount(deps.paths, name);
      log(`Added login account "${name}": Claude's config dir is ${added.configDir}.`);
      if (values["no-login"]) {
        log(`Log in later with: CLAUDE_CONFIG_DIR=${added.configDir} claude  (then /login)`);
      } else {
        log("Starting claude there: log in (it may ask with /login), then quit it (/exit).");
        const code = await deps.runClaude(loginEnv(added));
        const who = added.configDir ? await loggedInAs(added.configDir) : null;
        log(
          who
            ? `Logged in as ${who}.`
            : `claude exited${code === null ? "" : ` (${code})`}; if you didn't log in, run CLAUDE_CONFIG_DIR=${added.configDir} claude`,
        );
      }
      log(`Use it for new jobs: sf-runner account use ${name}`);
      return 0;
    }
    case "use": {
      if (!name) break;
      await useAccount(deps.paths, name);
      log(`New jobs use "${name}"; running jobs keep the account they started on.`);
      return 0;
    }
    case "remove": {
      if (!name) break;
      const live = await deps.liveJobs();
      const jobs = live ?? new Set(await deps.allRuns());
      await removeAccount(deps.paths, name, await accountsInUse(deps.runsDir, jobs));
      log(`Removed "${name}" and its config dir.`);
      return 0;
    }
  }
  log(ACCOUNT_USAGE);
  return 2;
}
