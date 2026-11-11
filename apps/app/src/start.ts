// TanStack Start instance. Server functions are same-origin RPC: cross-site calls are rejected
// before anything else runs. Each server function resolves the signed-in user itself (fns.ts).
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
