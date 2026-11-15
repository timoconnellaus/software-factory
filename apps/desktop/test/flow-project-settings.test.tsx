// A project's Settings tab through the real router (the new core's software milestone), on the
// fixture door (screenshots/flow-fixtures.ts): its name and key, the repository picker over what
// the org's GitHub connection reaches, the connect button for an org without one, the repository
// as a pill in the header, and the built-in github gateway on Gateways. What the picker and the
// buttons send is clicked through in screenshots/behave.mjs.
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { flowGithubReposQuery } from "../src/mainview/lib/flow-queries.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const ORG = "org_personal";
const repos = (orgId: string) => (client: QueryClient) =>
  client.prefetchQuery(flowGithubReposQuery(orgId));

describe("a project's Settings", () => {
  it("is the fourth tab: name and key, and the repository picked from the GitHub connection", async () => {
    const html = await renderPage(`/flow/${ORG}/p/fprj_api?view=settings`, { after: repos(ORG) });
    const text = textOf(html);
    expect(text).toContain("API Platform Board List Workflow Settings");
    expect(html).toContain('data-testid="project-settings"');
    expect(text).toContain("Name API Platform Key API");
    expect(html).toContain('data-testid="repo-picker"');
    expect(text).toContain("acme/api");
    expect(html).toContain('data-testid="clear-repo"');
    expect(text).toContain("GitHub, connected as acme");
    expect(text).toContain("Its default branch is main");
    expect(html).not.toContain('data-testid="connect-github"');
    // The repository is a quiet pill in the header; no board, no item panel here.
    expect(html).toContain('data-testid="project-repo"');
    expect(html).not.toContain('data-testid="board-column"');
  });

  it("offers a project without a repository the picker, with nothing chosen", async () => {
    const html = await renderPage(`/flow/${ORG}/p/fprj_launch?view=settings`, {
      after: repos(ORG),
    });
    expect(textOf(html)).toContain("Choose a repository");
    expect(html).not.toContain('data-testid="clear-repo"');
    expect(html).not.toContain('data-testid="project-repo"');
  });

  it("is one line and Connect GitHub when the org has no GitHub connection", async () => {
    const html = await renderPage("/flow/org_client/p/fprj_site?view=settings", {
      after: repos("org_client"),
    });
    expect(html).toContain('data-testid="github-not-connected"');
    expect(textOf(html)).toContain("This org has no GitHub connection yet. Connect GitHub");
    expect(html).not.toContain('data-testid="repo-picker"');
  });

  it("says so when the repositories can't be read", async () => {
    const html = await renderPage(`/flow/${ORG}/p/fprj_api?view=settings`, {
      answers: { "flow.github.repos": { error: "GitHub is down." } },
      after: async (client) => {
        await client.prefetchQuery(flowGithubReposQuery(ORG)).catch(() => null);
      },
    });
    expect(textOf(html)).toContain("Couldn't load the repositories. GitHub is down.");
  });

  it("reads the repositories only on Settings", async () => {
    const seen: string[] = [];
    await renderPage(`/flow/${ORG}/p/fprj_api`, {
      answers: {
        "flow.github.repos": (input) => {
          seen.push(JSON.stringify(input));
          return { connected: false, account: null, repos: [] };
        },
      },
    });
    expect(seen).toEqual([]);
  });
});

describe("Gateways", () => {
  it("lists the built-in github gateway read-only, after the org's own", async () => {
    const html = await renderPage(`/flow/${ORG}/plugins?tab=gateways`);
    const text = textOf(html);
    expect(html.split('data-testid="gateway-builtin"').length - 1).toBe(1);
    expect(text).toContain("GitHub Connected as acme The item's repository Connected Built in");
    // Edit and Remove only on the org's own four.
    expect(html.split('data-testid="edit-gateway"').length - 1).toBe(4);
    expect(html.split('data-testid="remove-gateway"').length - 1).toBe(4);
  });
});
