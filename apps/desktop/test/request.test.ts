// The bug behind "The requested method has no handler: undefined": Electrobun's request proxy is a
// function, so `request.call` was Function.prototype.call. bunRequests always passes the name.
import { describe, expect, it } from "vitest";
import { bunRequests } from "../src/mainview/request.ts";

/** Electrobun's own shape (api/shared/rpc.ts): a Proxy over the request function. */
function electrobunStyle(requestFn: (method: string, params: unknown) => Promise<unknown>) {
  return new Proxy(requestFn, {
    get: (target, prop, receiver) => {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return (params: unknown) => requestFn(prop as string, params);
    },
  }) as unknown as Record<string, (p: unknown) => Promise<unknown>> & typeof requestFn;
}

describe("the view's request handle", () => {
  it("shows the bug with Electrobun's proxy, and sends the right method through bunRequests", async () => {
    const seen: (string | undefined)[] = [];
    const fn = async function (this: unknown, method: string) {
      seen.push(method);
      return { ok: true };
    };
    const raw = electrobunStyle(fn);
    // `call` resolves to Function.prototype.call: the method arrives as the params object.
    // biome-ignore lint/suspicious/noExplicitAny: calling the built-in on purpose, to show the bug.
    await (raw.call as any)({ op: "inbox.list", input: {} });
    expect(typeof seen[0]).not.toBe("string");

    const bun = bunRequests((method, params) => raw(method, params));
    await bun.call({ op: "inbox.list", input: {} });
    await bun.batch({ calls: [] });
    await bun.session({});
    expect(seen.slice(1)).toEqual(["call", "batch", "session"]);
  });
});
