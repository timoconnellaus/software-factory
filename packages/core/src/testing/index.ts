// Test helpers for packages that build on core: a fake GitHub App and fake services.
import { r2AttachmentBlobs } from "../attachments.ts";
import type { FactoryServices } from "../services.ts";
import { type FakeGitHub, fakeGitHub } from "./fake-github.ts";

export {
  FAKE_APP,
  type FakeGitHub,
  type FakeInstallation,
  fakeGitHub,
  fakeUserToken,
} from "./fake-github.ts";

/**
 * Services for tests: the D1-backed fake GitHub, a runner key derived without a real secret, and
 * attachment storage on the given (real, workerd) R2 binding when there is one.
 */
export function fakeServices(
  d1: D1Database,
  attachments?: R2Bucket,
): FactoryServices & { github: FakeGitHub } {
  return {
    github: fakeGitHub(d1),
    ...(attachments ? { attachments: r2AttachmentBlobs(attachments) } : {}),
    runnerKey: async (runnerId, version) => `test-key:${runnerId}:v${version}`,
  };
}
