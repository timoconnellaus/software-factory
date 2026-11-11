// Test helpers for packages that build on core: a fake GitHub App and fake services.
import type { FactoryServices } from "../services.ts";
import { type FakeGitHub, fakeGitHub } from "./fake-github.ts";

export { FAKE_APP, type FakeGitHub, fakeGitHub } from "./fake-github.ts";

/** Services for tests: the D1-backed fake GitHub and a runner key derived without a real secret. */
export function fakeServices(d1: D1Database): FactoryServices & { github: FakeGitHub } {
  return {
    github: fakeGitHub(d1),
    runnerKey: async (runnerId, version) => `test-key:${runnerId}:v${version}`,
  };
}
