// Saving a file the view hands over (a ruleset to import on GitHub, an attachment) to ~/Downloads:
// the webview can't download. The name is reduced to a safe basename and never overwrites a file.
import { existsSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** A filename that can't leave the folder or hide: letters, digits, `.`, `_`, `-`. */
export function safeFilename(raw: string): string {
  const name = basename(raw)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return name || "download";
}

/** Writes the bytes under `dir` with a free name (`x.json`, `x-1.json`, …); returns the path. */
export function saveTo(dir: string, filename: string, bytes: Uint8Array): string {
  const name = safeFilename(filename);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let path = join(dir, name);
  for (let i = 1; existsSync(path); i++) path = join(dir, `${stem}-${i}${ext}`);
  writeFileSync(path, bytes, { flag: "wx" });
  return path;
}
