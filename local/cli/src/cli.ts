#!/usr/bin/env node
// `sf`: the software factory from a terminal (spec 07). `sf --help` lists the commands.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { main } from "./main.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  open:
    process.platform === "darwin"
      ? (url) => {
          spawn("open", [url], { stdio: "ignore", detached: true })
            .on("error", () => {})
            .unref();
        }
      : null,
  readStdin,
  readFile: (path) => readFile(path, "utf8"),
  now: Date.now,
});
process.exitCode = code;
