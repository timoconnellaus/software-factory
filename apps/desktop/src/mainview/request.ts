// The view's typed handle on the main process's requests. Electrobun's `rpc.request` is a Proxy
// over a *function*, and it answers any property the function already has from that function: so
// `request.call(...)` is Function.prototype.call (and `apply`, `bind`, `name`, `length` likewise),
// and the main process sees a request for method `undefined`. This calls the request function with
// the method name every time, so any request name works.
import type { AppRPC } from "../shared/rpc.ts";

type Requests = AppRPC["bun"]["requests"];
export type BunRequests = {
  [K in keyof Requests]: (p: Requests[K]["params"]) => Promise<Requests[K]["response"]>;
};

export type RequestFn = (method: string, params: unknown) => Promise<unknown>;

export function bunRequests(request: RequestFn): BunRequests {
  return new Proxy({} as BunRequests, {
    get: (_target, method) =>
      typeof method === "string" ? (params: unknown) => request(method, params) : undefined,
  });
}
