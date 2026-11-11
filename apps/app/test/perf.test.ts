// Page speed guards: reads batch into one request per page, every server function reports where its
// time went, and no page renders a query its loader didn't ask for (so nothing fetches after render).
import { describe, expect, it } from "vitest";
import { runReads, Timings } from "#/server/app-api";
import { recordingEngine, signIn, testEnv, uid } from "./helpers.ts";

describe("batched reads", () => {
  it("resolves the session once and runs every read as the signed-in person, in parallel", async () => {
    const login = uid("gh-");
    let inFlight = 0;
    let most = 0;
    const { engine, calls } = recordingEngine();
    const slow = {
      async invoke(...args: Parameters<typeof engine.invoke>) {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { ...(await engine.invoke(...args)), ms: 1.5 };
      },
    };
    const appEnv = testEnv(slow, login);
    const { user, headers } = await signIn(appEnv, login);
    const timings = new Timings();
    const results = await runReads(
      appEnv,
      headers,
      [
        { name: "workItem.get", input: { workItemId: "wi_1" } },
        { name: "workItem.timeline", input: { workItemId: "wi_1" } },
        { name: "runner.list", input: {} },
      ],
      timings,
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["workItem.get", "workItem.timeline", "runner.list"]);
    expect(calls.every((c) => c.options.actor.id === user.id)).toBe(true);
    expect(most).toBe(3);
    const header = timings.header();
    expect(header).toMatch(/^auth;dur=[\d.]+, /);
    expect(header).toMatch(/op0;desc="workItem\.get";dur=[\d.]+/);
    expect(header).toContain('engine2;desc="runner.list in engine";dur=1.5');
  });

  it("takes reads only: a write in a batch refuses the whole batch and reaches nothing", async () => {
    const login = uid("gh-");
    const { engine, calls } = recordingEngine();
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    const results = await runReads(appEnv, headers, [
      { name: "inbox.list", input: {} },
      { name: "review.merge", input: { workItemId: "wi_1" } },
    ]);
    expect(results).toEqual([
      { ok: false, code: "invalid_input", message: "unknown operation" },
      { ok: false, code: "invalid_input", message: "unknown operation" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("refuses every read without a session", async () => {
    const { engine, calls } = recordingEngine();
    const results = await runReads(testEnv(engine), new Headers(), [
      { name: "inbox.list", input: {} },
      { name: "runner.list", input: {} },
    ]);
    expect(results.map((r) => !r.ok && r.code)).toEqual(["unauthenticated", "unauthenticated"]);
    expect(calls).toHaveLength(0);
  });
});

// Source of the signed-in pages and the components they render, as text.
const routes = import.meta.glob<string>("../src/routes/_app/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});
const layout = import.meta.glob<string>("../src/routes/_app.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});
const components = import.meta.glob<string>("../src/components/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Pages another session owns that fetch on demand by design (Setup, connecting a runner). */
const EXEMPT = new Set(["setup.tsx", "runners.connect.tsx"]);

/** The route's options: `createFileRoute(...)({ ... })` up to the first top-level `});`. */
function routeOptions(source: string): string {
  const start = source.indexOf("createFileRoute(");
  const end = source.indexOf("\n});", start);
  return start < 0 ? "" : source.slice(start, end);
}

/** Query factories (`inboxQuery(`, `workItemQuery(`) a piece of source uses. */
function queriesIn(source: string): Set<string> {
  const names = [...source.matchAll(/\b([a-z]\w*Query)\(/g)].map((m) => m[1] as string);
  // useProjects() reads projectsQuery.
  if (/\buseProjects\(/.test(source)) names.push("projectsQuery");
  return new Set(names.filter((n) => !n.startsWith("use")));
}

/** The components a page renders (one level: `#/components/x`), as source. */
function componentSources(source: string): string[] {
  return [...source.matchAll(/from "#\/components\/([\w-]+)"/g)].map(
    (m) => components[`../src/components/${m[1]}.tsx`] ?? "",
  );
}

describe("every page's loader asks for everything the page renders", () => {
  const shell = queriesIn(routeOptions(Object.values(layout)[0] ?? ""));
  const pages = Object.entries(routes).filter(
    ([path]) => !EXEMPT.has(path.split("/").at(-1) ?? path),
  );

  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(shell).toEqual(new Set(["sessionQuery", "projectsQuery", "inboxQuery"]));
  });

  for (const [path, source] of pages) {
    it(path.split("/").at(-1) ?? path, () => {
      const loaded = new Set([...shell, ...queriesIn(routeOptions(source))]);
      const rendered = new Set([
        ...queriesIn(source.replace(routeOptions(source), "")),
        ...componentSources(source).flatMap((c) => [...queriesIn(c)]),
      ]);
      const missing = [...rendered].filter((q) => !loaded.has(q));
      expect(missing, "queries rendered but not loaded (they would fetch after render)").toEqual(
        [],
      );
    });
  }

  it("the shell's own components are covered by the shell's loader", () => {
    const shellComponents = componentSources(Object.values(layout)[0] ?? "");
    const missing = shellComponents.flatMap((c) => [...queriesIn(c)]).filter((q) => !shell.has(q));
    expect(missing).toEqual([]);
  });
});
