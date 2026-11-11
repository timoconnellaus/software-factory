// TanStack Start instance. Server functions are same-origin RPC: cross-site calls are rejected
// before anything else runs. Each server function resolves the signed-in user itself (fns.ts).
import { createSerializationAdapter } from "@tanstack/react-router";
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { OpError } from "./lib/ops.ts";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * A loader's refusal keeps its code from the server render to the browser, so an error page reads
 * the same whether it was rendered on the server or after a client navigation.
 */
const opErrorAdapter = createSerializationAdapter({
  key: "sf-op-error",
  test: (value): value is OpError => value instanceof OpError,
  toSerializable: (error) => ({ code: error.code, message: error.message }),
  fromSerializable: ({ code, message }) => new OpError(code, message),
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  serializationAdapters: [opErrorAdapter],
}));
