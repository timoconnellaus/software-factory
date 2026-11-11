// /api/auth/* (Better Auth) and /api/factory/* (this spike). Everything else falls through to
// TanStack Start. Tests call this directly.
import { handleApi } from "./api.ts";
import { AUTH_BASE_PATH, type AuthEnv, createAuth } from "./auth.ts";

export async function handleServerRequest(
  request: Request,
  env: AuthEnv,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const isAuth = pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`);
  const isApi = pathname.startsWith("/api/factory/");
  if (!isAuth && !isApi) return null;
  const auth = createAuth(env);
  if (isAuth) return auth.handler(request);
  return handleApi(auth, env.DB, request);
}
