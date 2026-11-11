import { env } from "cloudflare:test";
import type { AuthEnv } from "../src/server/auth.ts";
import { handleServerRequest } from "../src/server/handler.ts";

export const ORIGIN = "http://localhost:5173";

export const authEnv: AuthEnv = {
  DB: env.DB,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  BETTER_AUTH_URL: ORIGIN,
  AUTH_EMAIL_PASSWORD: "true",
};

/** A browser: one cookie jar that every request sends and every response updates. */
export class Browser {
  readonly cookies = new Map<string, string>();

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async fetch(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN, cookie: this.cookieHeader() });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const request = new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const response = await handleServerRequest(request, authEnv);
    if (!response) throw new Error(`No handler for ${path}`);
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}) {
    const response = await this.fetch(path, init);
    return { status: response.status, body: (await response.json()) as T };
  }

  signUp(email: string, name = email.split("@")[0] ?? "user") {
    return this.json<{ user: { id: string } }>("/api/auth/sign-up/email", {
      body: { email, password: "correct-horse-battery", name },
    });
  }

  signIn(email: string) {
    return this.json<{ user: { id: string } }>("/api/auth/sign-in/email", {
      body: { email, password: "correct-horse-battery" },
    });
  }
}

let counter = 0;
/** A unique email per test: D1 storage is shared across tests in a file. */
export function email(label: string): string {
  counter += 1;
  return `${label}-${counter}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}
