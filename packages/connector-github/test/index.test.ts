import { describe, expect, it } from "vitest";
import { routeGitHubEvent } from "../src/index.ts";

const SLUG = "software-factory-zerobsai";
const repository = { name: "software-factory", owner: { login: "timoconnellaus" } };
const repo = { owner: "timoconnellaus", name: "software-factory" };
const sha = (c: string) => c.repeat(40);

describe("routing GitHub App webhooks", () => {
  it("re-evaluates factory/verify when a PR opens or gets a new push", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      const routed = routeGitHubEvent(
        "pull_request",
        {
          action,
          repository,
          pull_request: {
            number: 7,
            head: { sha: sha("a"), ref: "factory/1-x" },
            base: { ref: "main" },
          },
        },
        SLUG,
      );
      expect(routed.calls).toEqual([
        {
          op: "verify.refresh",
          input: { repo, headSha: sha("a"), prNumber: 7, trigger: "pull_request" },
        },
      ]);
    }
    const closed = routeGitHubEvent(
      "pull_request",
      {
        action: "closed",
        repository,
        pull_request: { number: 7, head: { sha: sha("a"), ref: "x" }, base: { ref: "main" } },
      },
      SLUG,
    );
    expect(closed).toMatchObject({ calls: [], ignored: "pull_request closed" });
  });

  it("re-evaluates when CI's check suite completes, but never for the factory's own checks", () => {
    const suite = (slug: string, action = "completed") =>
      routeGitHubEvent(
        "check_suite",
        {
          action,
          repository,
          check_suite: { head_sha: sha("b"), status: "completed", app: { slug } },
        },
        SLUG,
      );
    expect(suite("github-actions").calls).toEqual([
      { op: "verify.refresh", input: { repo, headSha: sha("b"), trigger: "ci" } },
    ]);
    expect(suite(SLUG).calls).toEqual([]);
    expect(suite("github-actions", "requested").calls).toEqual([]);
    const rerun = routeGitHubEvent(
      "check_run",
      {
        action: "rerequested",
        repository,
        check_run: { name: "factory/verify", head_sha: sha("c"), app: { slug: SLUG } },
      },
      SLUG,
    );
    expect(rerun.calls[0]?.input.trigger).toBe("rerequested");
    const own = routeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository,
        check_run: { name: "factory/verify", head_sha: sha("c"), app: { slug: SLUG } },
      },
      SLUG,
    );
    expect(own.calls).toEqual([]);
  });

  it("observes pushes and recognises the App's own", () => {
    const routed = routeGitHubEvent(
      "push",
      {
        ref: "refs/heads/factory/1-x-run-1",
        before: sha("0"),
        after: sha("d"),
        repository,
        sender: { login: `${SLUG}[bot]`, type: "Bot" },
      },
      SLUG,
    );
    expect(routed.calls).toEqual([
      {
        op: "push.observe",
        input: {
          repo,
          ref: "refs/heads/factory/1-x-run-1",
          before: sha("0"),
          after: sha("d"),
          pusher: `${SLUG}[bot]`,
          pusherIsApp: true,
        },
      },
    ]);
    const human = routeGitHubEvent(
      "push",
      {
        ref: "refs/heads/main",
        before: sha("0"),
        after: sha("e"),
        repository,
        sender: { login: "timoconnellaus" },
      },
      SLUG,
    );
    expect(human.calls[0]?.input.pusherIsApp).toBe(false);
  });

  it("tracks installations", () => {
    const installation = { id: 99, account: { login: "timoconnellaus" } };
    expect(
      routeGitHubEvent(
        "installation",
        { action: "created", installation, repositories: [{ name: "software-factory" }] },
        SLUG,
      ).calls,
    ).toEqual([
      {
        op: "github.installation",
        input: {
          installationId: "99",
          account: "timoconnellaus",
          action: "added",
          repositories: ["software-factory"],
        },
      },
    ]);
    expect(
      routeGitHubEvent("installation", { action: "deleted", installation }, SLUG).calls[0]?.input,
    ).toMatchObject({
      action: "removed",
      repositories: null,
    });
    const changed = routeGitHubEvent(
      "installation_repositories",
      {
        action: "added",
        installation,
        repositories_added: [{ name: "a" }],
        repositories_removed: [{ name: "b" }],
      },
      SLUG,
    );
    expect(changed.calls.map((c) => c.input.action)).toEqual(["added", "removed"]);
  });

  it("ignores pings, unknown events and unreadable payloads", () => {
    expect(routeGitHubEvent("ping", { zen: "x" }, SLUG).ignored).toBe("ping");
    expect(routeGitHubEvent("issues", {}, SLUG).ignored).toMatch(/isn't used/);
    expect(routeGitHubEvent("push", { nope: true }, SLUG).ignored).toMatch(/unreadable/);
  });
});
