// The cache belongs to one sign-in (review of #184): another login or device while signed in
// resets it, as signing in or out does, and the signed-out error never leaves an empty window.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SignedOutWait } from "../src/mainview/components/app-error.tsx";
import { accountKey, clearAccountData } from "../src/mainview/lib/account.ts";
import { DRAG } from "../src/mainview/lib/title-bar.ts";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

describe("accountKey", () => {
  it("changes with the login and the device, not only with signed in", () => {
    const owner = accountKey({ signedIn: true, login: "owner", deviceId: "dev_m5" });
    expect(owner).toBe("in:owner:dev_m5");
    expect(accountKey({ signedIn: true, login: "other", deviceId: "dev_m5" })).not.toBe(owner);
    expect(accountKey({ signedIn: true, login: "owner", deviceId: "dev_m1" })).not.toBe(owner);
    expect(accountKey({ signedIn: false, login: null, deviceId: null })).toBe("out");
    expect(accountKey(null)).toBeNull();
  });
});

describe("clearAccountData", () => {
  it("leaves nothing the previous account read, only the app's session and update status", () => {
    const client = new QueryClient();
    client.setQueryData(["me"], { userId: "u_owner" });
    client.setQueryData(["inbox"], { gates: [{ id: "g_owner" }] });
    client.setQueryData(["workItem", "wi_owner"], { item: { title: "owner's item" } });
    client.setQueryData(["session"], { signedIn: true, login: "other" });
    client.setQueryData(["update"], { required: false });
    clearAccountData(client);
    expect(client.getQueryData(["me"])).toBeUndefined();
    expect(client.getQueryData(["inbox"])).toBeUndefined();
    expect(client.getQueryData(["workItem", "wi_owner"])).toBeUndefined();
    expect(client.getQueryData(["session"])).toEqual({ signedIn: true, login: "other" });
    expect(client.getQueryData(["update"])).toEqual({ required: false });
  });
});

describe("a signed-out refusal on the error screen", () => {
  const render = (late: boolean) =>
    renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <SignedOutWait late={late} busy={false} retry={() => undefined} />
      </QueryClientProvider>,
    );

  it("shows the window's loading shell first (it drags), never nothing", () => {
    const html = render(false);
    expect(html).toContain('data-testid="window-skeleton"');
    expect(html).toContain('data-testid="toolbar-skeleton"');
  });

  it("then a line with Retry, over the drag strip", () => {
    const html = render(true);
    expect(html).toContain('data-testid="signed-out-wait"');
    expect(html).toContain("Retry");
    expect(html).toContain(`fixed inset-x-0 top-0 h-11 ${DRAG}`);
  });
});
