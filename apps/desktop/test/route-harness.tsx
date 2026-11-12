// Renders a real page of the app, through the real route tree, against the screenshot harness's
// fixture door (spec 41): the route-level tests see a read pending, failed or answered empty, as
// the window would. Reads are answered from fixtures.ts unless a test overrides one. Rendered to a
// string on Node: no effects run, so nothing refetches. A test file stubs the main process with
//   vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));
import type { OpName } from "@software-factory/client/ops";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { ANSWERS } from "../screenshots/fixtures.ts";
import type { CallResult } from "../src/shared/rpc.ts";

/** How a test answers one read: a value, a refusal, or the fixture's answer changed. */
export type Answer = { result: unknown } | { error: string } | ((input: unknown) => unknown);

export interface RenderOptions {
  /** Reads answered differently from the fixtures, by operation. */
  answers?: Partial<Record<OpName, Answer>>;
  /** Query keys (prefixes) left pending after the loaders ran: the page renders while they load. */
  pending?: unknown[][];
}

function answer(op: string, input: unknown, answers: RenderOptions["answers"]): CallResult {
  const a = answers?.[op as OpName];
  if (a && typeof a === "object" && "error" in a)
    return { ok: false, code: "unavailable", error: a.error };
  if (a && typeof a === "object" && "result" in a) return { ok: true, result: a.result };
  if (typeof a === "function") return { ok: true, result: a(input) };
  const f = ANSWERS[op as OpName] as ((i: unknown) => unknown) | undefined;
  if (!f) return { ok: false, code: "unavailable", error: `no fixture for ${op}` };
  return { ok: true, result: f(input) };
}

/** The page at `path`, rendered as the window shows it, as HTML. */
export async function renderPage(path: string, options: RenderOptions = {}): Promise<string> {
  const { connect } = await import("../src/mainview/lib/op.ts");
  const { routeTree } = await import("../src/mainview/router.tsx");
  connect({
    call: async (p) => answer(p.op, p.input, options.answers),
    batch: async (p) => p.calls.map((c) => answer(c.op, c.input, options.answers)),
    decide: async (p) => answer(p.op, p.input, options.answers),
  });
  // A failed read is retried when the page mounts, then settles as failed: render that settled state.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  queryClient.setQueryData(["session"], SESSION);
  queryClient.setQueryData(["update"], { required: false });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });
  await router.load();
  for (const key of options.pending ?? []) queryClient.removeQueries({ queryKey: key });
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const SESSION = {
  signedIn: true,
  login: "owner",
  deviceId: "dev_m5",
  keyStorage: "secure-enclave",
  signingIn: false,
  error: null,
};

/** The page's text, tags stripped and spaces collapsed. */
export const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
