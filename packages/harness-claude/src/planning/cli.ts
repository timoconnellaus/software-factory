// `node cli.ts mcp <relayFile>` runs the planning MCP server; `node cli.ts hook <event> <relayFile>`
// runs one planning hook. The runner projects both into a planning session's settings (ADR 0340),
// started with the runner host's own Node (`--experimental-transform-types`, as `sf-runner` runs).

import { type HookPayload, runNewsHook, runStopHook } from "./hooks.ts";
import { serveMcp } from "./mcp.ts";
import { readRelay } from "./relay.ts";

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  return text;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === "mcp") {
    const relayFile = rest[0];
    if (!relayFile) throw new Error("usage: cli.ts mcp <relayFile>");
    await serveMcp(await readRelay(relayFile));
    return;
  }
  if (command !== "hook") throw new Error("usage: cli.ts mcp|hook …");
  const [event, relayFile] = rest;
  if (!event || !relayFile) throw new Error("usage: cli.ts hook <event> <relayFile>");
  if (event === "stop") {
    let text: string | null = null;
    try {
      await readStdin();
      text = await runStopHook({ relayFile, relay: await readRelay(relayFile) });
    } catch {
      text = null;
    }
    // asyncRewake: exit 2 with the news on stderr wakes the model; 0 lets it stay stopped.
    if (!text) process.exit(0);
    process.stderr.write(`${text}\n`, () => process.exit(2));
    return;
  }
  let response: Record<string, unknown> = {};
  try {
    const payload = JSON.parse((await readStdin()).trim() || "{}") as HookPayload;
    const hookEvent =
      event === "post-tool-use"
        ? "PostToolUse"
        : event === "user-prompt-submit"
          ? "UserPromptSubmit"
          : null;
    if (hookEvent) {
      response = await runNewsHook(hookEvent, payload, {
        relayFile,
        relay: await readRelay(relayFile),
      });
    }
  } catch {
    // The agent's work matters more than the news.
  }
  process.stdout.write(`${JSON.stringify(response)}\n`, () => process.exit(0));
}

await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
