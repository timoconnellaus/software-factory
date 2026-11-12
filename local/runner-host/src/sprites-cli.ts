// `sf-runner sprites …` (ADR 0480, spec 36): the owner's Sprites token on this host. The host makes
// a sprite per job with it; the factory never sees it, and no sprite ever holds it.
//
//   sf-runner sprites login [--no-check]   the token on stdin (from https://sprites.dev/account,
//                                          or `sprite` CLI's org token), kept 0600 next to the
//                                          runner key, then checked against the API
//   sf-runner sprites status               the token, the API, this runner's sprites
//   sf-runner sprites logout               removes the token
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { SandboxApi } from "@software-factory/runner-local";

export interface SpritesCliDeps {
  tokenFile: string;
  /** This runner's sprite name prefix (`sf-<runner>-`); null when the runner isn't paired yet. */
  namePrefix: string | null;
  isolation: string | null;
  readStdin: () => Promise<string>;
  api: (token: string) => SandboxApi;
  readToken: () => Promise<string>;
  log: (line: string) => void;
}

export const SPRITES_USAGE =
  "usage: sf-runner sprites login [--no-check] (token on stdin) | status | logout";

export async function spritesCommand(args: string[], deps: SpritesCliDeps): Promise<number> {
  const [verb, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { "no-check": { type: "boolean" } },
  });
  const log = deps.log;
  switch (verb) {
    case "login": {
      const token = (await deps.readStdin()).trim();
      if (!token || /\s/.test(token)) {
        log("Pipe the token in: pbpaste | sf-runner sprites login  (one line, no spaces)");
        return 2;
      }
      if (!values["no-check"]) {
        try {
          await deps.api(token).check();
        } catch (err) {
          log(`Sprites refused the token: ${err instanceof Error ? err.message : err}`);
          return 1;
        }
      }
      await mkdir(dirname(deps.tokenFile), { recursive: true, mode: 0o700 });
      await writeFile(deps.tokenFile, `${token}\n`, { mode: 0o600 });
      await chmod(deps.tokenFile, 0o600);
      log(`Saved the Sprites token in ${deps.tokenFile} (0600). It never leaves this machine.`);
      if (deps.isolation !== "sprites") {
        log(
          'Run jobs in sprites: set "isolation": "sprites" in runner.json, then sf-runner install.',
        );
      }
      return 0;
    }
    case "status": {
      let token: string;
      try {
        token = await deps.readToken();
      } catch (err) {
        log(err instanceof Error ? err.message : String(err));
        return 1;
      }
      log(`token: ${deps.tokenFile} (${token.slice(0, 6)}…)`);
      const api = deps.api(token);
      try {
        await api.check();
        log("api: ok");
      } catch (err) {
        log(`api: ${err instanceof Error ? err.message : err}`);
        return 1;
      }
      if (deps.namePrefix) {
        const mine = await api.list(deps.namePrefix);
        log(`sprites of this runner (${deps.namePrefix}*): ${mine.length}`);
        for (const s of mine) log(`  ${s.name}  ${s.status}`);
      }
      log(`isolation: ${deps.isolation ?? "(not paired)"}`);
      return 0;
    }
    case "logout": {
      await rm(deps.tokenFile, { force: true });
      log(`Removed ${deps.tokenFile}. Revoke the token at https://sprites.dev/account too.`);
      return 0;
    }
  }
  log(SPRITES_USAGE);
  return 2;
}
