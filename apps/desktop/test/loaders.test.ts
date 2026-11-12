// Every page's loader asks for everything the page renders (ported from sf-app's perf test, ADR
// 0241): a page's reads go out in one `batch` on the client door, and nothing fetches after render.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../src/mainview/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, dir), "utf8");
const pageFiles = readdirSync(new URL("routes/", dir)).filter((f) => f.endsWith(".tsx"));

/** Not pages under the layout, or pages that read on demand by design (Setup asks GitHub). */
const EXEMPT = new Set(["root.tsx", "_app.tsx", "settings.tsx", "setup.tsx"]);

/** The route's options: `createRoute({ ... })` up to the first top-level `});`. */
function routeOptions(source: string): string {
  const start = source.indexOf("createRoute(");
  const end = source.indexOf("\n});", start);
  return start < 0 ? "" : source.slice(start, end);
}

/** Query factories (`inboxQuery(`, `workItemQuery(`) a piece of source uses. */
function queriesIn(source: string): Set<string> {
  const names = [...source.matchAll(/(?<![\w$]\.)\b([a-z]\w*Query)\(/g)].map((m) => m[1] as string);
  if (/\buseProjects\(/.test(source)) names.push("projectsQuery");
  return new Set(names.filter((n) => !n.startsWith("use")));
}

/** The components a page renders (one level: `../components/x.tsx`), as source. */
function componentSources(source: string): string[] {
  return [...source.matchAll(/from "\.\.\/components\/([\w-]+)\.tsx"/g)].map((m) =>
    read(`components/${m[1]}.tsx`),
  );
}

describe("every page's loader asks for everything the page renders", () => {
  const layout = read("routes/_app.tsx");
  const shell = queriesIn(routeOptions(layout));
  const pages = pageFiles.filter((f) => !EXEMPT.has(f));

  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(shell).toEqual(new Set(["meQuery", "projectsQuery", "inboxQuery", "workListsQuery"]));
  });

  for (const file of pages) {
    it(file, () => {
      const source = read(`routes/${file}`);
      expect(source, "a page, not a stub").not.toMatch(/^\/\/ STUB/);
      const loaded = new Set([...shell, ...queriesIn(routeOptions(source))]);
      const rendered = new Set([
        ...queriesIn(source.replace(routeOptions(source), "")),
        ...componentSources(source).flatMap((c) => [...queriesIn(c)]),
      ]);
      // Attachment bytes load when an image scrolls into view, by design.
      rendered.delete("attachmentBytesQuery");
      const missing = [...rendered].filter((q) => !loaded.has(q));
      expect(missing, "queries rendered but not loaded (they would fetch after render)").toEqual(
        [],
      );
    });
  }

  it("the shell's own components are covered by the shell's loader", () => {
    // Focus mode's bar shows only on a work item's page, whose loader reads the item and its
    // planning (checked above as work.$id.index.tsx).
    const missing = componentSources(read("routes/_app.tsx").replace(/^import .*focus-bar.*$/m, ""))
      .flatMap((c) => [...queriesIn(c)])
      .filter((q) => !shell.has(q));
    expect(missing).toEqual([]);
  });

  it("every page is in the route tree", () => {
    const router = read("router.tsx");
    for (const file of pageFiles.filter((f) => f !== "root.tsx" && f !== "_app.tsx")) {
      expect(router).toContain(`./routes/${file}`);
    }
  });
});
