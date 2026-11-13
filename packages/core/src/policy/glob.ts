// Globs over repository paths, shared by skills (where a skill applies) and dark factory mode
// (allowPaths and the risk lists, ADR 0515).

/**
 * A glob over repository paths: `**` any directories, `*` within one segment, `?` one character.
 * Case-insensitive unless `caseSensitive` (allowPaths: a place an unattended change may touch
 * matches exactly).
 */
export function globMatch(glob: string, path: string, caseSensitive = false): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more directories; a trailing `**` anything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, caseSensitive ? "" : "i").test(path);
}
