import { expect, it } from "vitest";
import { PACKAGE } from "../src/index.ts";

it("exports its package name", () => {
  expect(PACKAGE).toBe("@software-factory/runner-host");
});
