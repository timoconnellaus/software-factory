// Writes native/sf-runner-launcher/Sources/LauncherCore/EntriesJSON.swift from
// local/runner-host/src/launcher-entries.json, so the table is compiled into the launcher (spec 45 §1, Entry points).
// The launcher's tests fail when the two differ: run this after editing the JSON.
//   node apps/desktop/scripts/launcher-entries.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "sf-runner-launcher");
const table = join(
  pkg,
  "..",
  "..",
  "..",
  "..",
  "local",
  "runner-host",
  "src",
  "launcher-entries.json",
);
const json = readFileSync(table, "utf8");
if (json.includes('"""#'))
  throw new Error("launcher-entries.json can't hold a raw-string terminator");
writeFileSync(
  join(pkg, "Sources", "LauncherCore", "EntriesJSON.swift"),
  `// Generated from local/runner-host/src/launcher-entries.json by apps/desktop/scripts/launcher-entries.mjs. Don't edit.\nlet entriesJSON = #"""\n${json}"""#\n`,
);
