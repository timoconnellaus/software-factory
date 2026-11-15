// The `sf` commands (spec 07). `main` takes its environment, fetch and output as arguments, so the
// whole CLI runs in tests against a fake engine; src/cli.ts wires the real ones.
import { hostname } from "node:os";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { type Api, httpApi, type OperationInfo, result } from "./api.ts";
import {
  type CliConfig,
  clearToken,
  configFile,
  loadConfig,
  type Settings,
  saveConfig,
  settings,
} from "./config.ts";
import { deviceLogin } from "./device-login.ts";
import { CliError, usage } from "./errors.ts";
import { oneLine, table } from "./format.ts";

export interface Io {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Opens a link in the browser; null where there's no `open` (anywhere but macOS). */
  open: ((url: string) => void) | null;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Ctx {
  io: Io;
  file: string;
  config: CliConfig;
  settings: Settings;
  api: Api;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

interface Command {
  usage: string;
  summary: string;
  options?: ParseArgsOptionsConfig;
  run(ctx: Ctx, values: Values, args: string[]): Promise<number | undefined>;
}

const COMMON: ParseArgsOptionsConfig = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
};

const str = (v: Values[string]) => (typeof v === "string" ? v : undefined);

function printJson(ctx: Ctx, value: unknown) {
  ctx.io.out(JSON.stringify(value, null, 2));
}

async function readInput(ctx: Ctx, arg: string | undefined): Promise<unknown> {
  if (arg === undefined) return {};
  let text: string;
  if (arg === "-") text = await ctx.io.readStdin();
  else if (arg.startsWith("@")) text = await ctx.io.readFile(arg.slice(1));
  else text = arg;
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw usage(`the input isn't JSON: ${oneLine(text, 60)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

const login: Command = {
  usage: "sf login [--write] [--name <name>] [--url <engine>] [--app-url <app>] [--no-open]",
  summary: "Log in by device code (a read token unless --write; you pick the scope in the app)",
  options: {
    write: { type: "boolean" },
    name: { type: "string" },
    url: { type: "string" },
    "app-url": { type: "string" },
    "no-open": { type: "boolean" },
  },
  async run(ctx, values) {
    const url = (str(values.url) ?? ctx.settings.url).replace(/\/+$/, "");
    const appUrl = (str(values["app-url"]) ?? ctx.settings.appUrl).replace(/\/+$/, "");
    const asked = values.write ? "write" : "read";
    const open = values["no-open"] ? null : ctx.io.open;
    const got = await deviceLogin({
      baseUrl: url,
      appUrl,
      name: str(values.name) ?? `sf on ${hostname()}`,
      scope: asked,
      fetch: ctx.io.fetch,
      now: ctx.io.now,
      print: ctx.io.out,
      ...(ctx.io.sleep ? { sleep: ctx.io.sleep } : {}),
      ...(open ? { open } : {}),
    });
    await saveConfig(ctx.file, {
      url,
      appUrl,
      token: got.token,
      tokenId: got.tokenId,
      scope: got.scope,
      login: got.login,
      expiresAt: got.expiresAt,
    });
    ctx.io.out("");
    ctx.io.out(
      `Logged in${got.login ? ` as ${got.login}` : ""} with a ${got.scope} token${got.expiresAt ? `, until ${got.expiresAt.slice(0, 10)}` : ""}.`,
    );
    if (got.scope !== asked) ctx.io.out(`You asked for ${asked}; the app granted ${got.scope}.`);
    ctx.io.out(`Saved to ${ctx.file}.`);
    if (ctx.settings.tokenSource === "env") {
      ctx.io.err("Note: SF_TOKEN is set in this shell and is used instead of this login.");
    }
    return 0;
  },
};

const logout: Command = {
  usage: "sf logout",
  summary: "Revoke the stored token and delete it",
  async run(ctx) {
    const { token, tokenId } = ctx.config;
    if (!token) {
      ctx.io.out("Not logged in: there's no stored token.");
      if (ctx.settings.tokenSource === "env") ctx.io.out("(SF_TOKEN is set; unset it yourself.)");
      return 0;
    }
    let failed: CliError | Error | null = null;
    if (tokenId) {
      // The stored token revokes itself, whatever SF_TOKEN says.
      const own = httpApi({ url: ctx.settings.url, token, fetch: ctx.io.fetch });
      try {
        await result(own, "cliToken.revoke", { tokenId });
      } catch (err) {
        failed = err instanceof Error ? err : new Error(String(err));
      }
    } else {
      failed = new Error("the config has no tokenId to revoke");
    }
    await clearToken(ctx.file, ctx.config);
    if (failed) {
      const why = failed instanceof CliError ? `${failed.code}: ${failed.message}` : failed.message;
      ctx.io.err(`Couldn't revoke the token on the factory (${why}).`);
      ctx.io.err(
        `Deleted it here anyway. It still works until it expires${ctx.config.expiresAt ? ` (${ctx.config.expiresAt.slice(0, 10)})` : ""}, unless revoked with \`sf call cliToken.revoke '{"tokenId":"${tokenId ?? "<id>"}"}'\` from another login.`,
      );
      return 1;
    }
    ctx.io.out("Revoked the token and deleted it.");
    return 0;
  },
};

const statusCommand: Command = {
  usage: "sf status [--json]",
  summary: "Where the CLI points, who it's logged in as, the scope and expiry",
  async run(ctx, values) {
    const { config, settings: s } = ctx;
    const expired = config.expiresAt ? Date.parse(config.expiresAt) <= ctx.io.now() : false;
    const view = {
      url: s.url,
      appUrl: s.appUrl,
      token: s.tokenSource === "env" ? "SF_TOKEN" : s.tokenSource === "config" ? ctx.file : null,
      login: config.login ?? null,
      scope: config.scope ?? null,
      expiresAt: config.expiresAt ?? null,
      expired,
    };
    if (values.json) {
      printJson(ctx, view);
      return s.token ? 0 : 1;
    }
    const rows = [
      ["engine", s.url],
      ["app", s.appUrl],
      ["token", view.token ?? "none: run `sf login`"],
    ];
    if (config.token) {
      rows.push(
        ["login", config.login ?? "?"],
        ["scope", config.scope ?? "?"],
        [
          "expires",
          config.expiresAt
            ? `${config.expiresAt}${expired ? " (expired: run `sf login`)" : ""}`
            : "?",
        ],
      );
    }
    for (const line of table(rows)) ctx.io.out(line);
    if (s.tokenSource === "env" && config.token) {
      ctx.io.out("(SF_TOKEN overrides the stored login above.)");
    }
    return s.token ? 0 : 1;
  },
};

const ops: Command = {
  usage: "sf ops [--json]",
  summary: "The operations, with their risk; browser-only ones are decided in the app",
  async run(ctx, values) {
    const list = await ctx.api.ops();
    if (values.json) {
      printJson(ctx, { operations: list });
      return 0;
    }
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    for (const line of table(
      sorted.map((o) => [
        o.name,
        o.risk,
        o.browserOnly ? "browser-only" : "",
        oneLine(o.description.split(/(?<=\.)\s/)[0] ?? "", 70),
      ]),
    )) {
      ctx.io.out(line);
    }
    return 0;
  },
};

const call: Command = {
  usage: "sf call <op> [<input-json> | @file | -]",
  summary: "Call any operation your token's scope allows; prints its result as JSON",
  async run(ctx, _values, args) {
    const [op, arg, ...extra] = args;
    if (!op) throw usage("which operation? `sf ops` lists them");
    if (extra.length) throw usage("pass the input as one JSON argument (quote it), @file or -");
    const input = await readInput(ctx, arg);
    printJson(ctx, await ctx.api.call(op, input));
    return 0;
  },
};

export const COMMANDS: Record<string, Command> = {
  login,
  logout,
  status: statusCommand,
  ops,
  call,
};

export function helpText(): string[] {
  const rows = Object.values(COMMANDS).map((c) => [c.usage.split(" [")[0] ?? c.usage, c.summary]);
  return [
    "sf: the software factory from a terminal. Decisions stay in the app.",
    "",
    "Usage: sf <command> [options]   (sf <command> --help for its options)",
    "",
    ...table(rows).map((l) => `  ${l}`),
    "",
    "Environment: SF_TOKEN (a token, overrides `sf login`), SF_URL (the engine), SF_APP_URL,",
    "XDG_CONFIG_HOME (config in $XDG_CONFIG_HOME/software-factory/cli.json).",
  ];
}

// ---------------------------------------------------------------------------------------------
// Errors: say what to do next

/** The ops list for hints, fetched at most once and never fatal. */
function opsLookup(api: Api) {
  let list: Promise<OperationInfo[] | null> | null = null;
  return (name: string) => {
    list ??= api.ops().catch(() => null);
    return list.then((l) => l?.find((o) => o.name === name) ?? null);
  };
}

/** Wrap the API so a refused call carries a hint: log in, use the app, or ask for write. */
function hinting(api: Api, ctx: () => Ctx): Api {
  const lookup = opsLookup(api);
  return {
    ops: () => api.ops(),
    async call(op, input) {
      try {
        return await api.call(op, input);
      } catch (err) {
        if (err instanceof CliError) err.hint = await hintFor(ctx(), err, op, lookup);
        throw err;
      }
    },
  };
}

async function hintFor(
  ctx: Ctx,
  err: CliError,
  op: string,
  lookup: (name: string) => Promise<OperationInfo | null>,
): Promise<string | null> {
  if (err.status === 401 || err.code === "unauthenticated") {
    return ctx.settings.tokenSource === "env"
      ? "SF_TOKEN was refused (revoked, expired or unknown). Get a new token with `sf login`."
      : "Run `sf login`.";
  }
  if (err.status !== 403 || err.code !== "forbidden") return null;
  const info = await lookup(op);
  const marked = (err.details as { browserOnly?: unknown } | undefined)?.browserOnly === true;
  if (marked || info?.browserOnly === true || /in the app|ADR 0340/i.test(err.message)) {
    return `${op} is decided in the app, not from the CLI. Do it there: ${ctx.settings.appUrl}`;
  }
  if (/sf login --write/.test(err.message)) return null;
  if (info && info.risk !== "read" && ctx.config.scope !== "write") {
    return ctx.settings.tokenSource === "env"
      ? `${op} is a ${info.risk} operation; SF_TOKEN may be a read token.`
      : `${op} is a ${info.risk} operation and this token is ${ctx.config.scope ?? "read"}-only. \`sf login --write\` for one that can write.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    for (const line of helpText()) io.out(line);
    return name ? 0 : 2;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`usage: unknown command ${name}. \`sf --help\` lists them.`);
    return 2;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...COMMON, ...command.options },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      io.out(`usage: ${command.usage}`);
      io.out(`  ${command.summary}`);
      return 0;
    }
    const file = configFile(io.env);
    const config = await loadConfig(file);
    const s = settings(config, io.env);
    const raw = httpApi({ url: s.url, token: s.token, fetch: io.fetch });
    const ctx: Ctx = { io, file, config, settings: s, api: raw };
    ctx.api = hinting(raw, () => ctx);
    return (await command.run(ctx, values, positionals)) ?? 0;
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`${err.code}: ${err.message}`);
      if (err.hint) io.err(err.hint);
      return err.code === "usage" ? 2 : 1;
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      io.err(`usage: ${(err as Error).message}`);
      io.err(`  ${command.usage}`);
      return 2;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
