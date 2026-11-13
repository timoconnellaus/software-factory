// "Restart to update", step by step (shared/update-apply.ts): what the window shows from the click.
import { describe, expect, it } from "vitest";
import { stepMarks } from "../src/mainview/components/updating.tsx";
import {
  type ApplyEvent,
  type ApplyState,
  applyStepText,
  applyTransition,
  IDLE,
} from "../src/shared/update-apply.ts";

const run = (events: ApplyEvent[], from: ApplyState = IDLE) =>
  events.reduce((s, e) => applyTransition(s, e), from);

describe("applyTransition", () => {
  it("idle → verifying → restarting", () => {
    const verifying = run([{ type: "start", version: "0.1.70" }]);
    expect(verifying).toEqual({ step: "verifying", version: "0.1.70", reason: null });
    expect(run([{ type: "restarting" }], verifying)).toMatchObject({ step: "restarting" });
  });

  it("goes through waiting for the runner when it drains it", () => {
    expect(
      run([{ type: "start", version: "0.1.70" }, { type: "waiting" }, { type: "restarting" }]),
    ).toMatchObject({ step: "restarting", version: "0.1.70" });
  });

  it("verifying → refused, with the refusal's words, and back to idle only when asked", () => {
    const refused = run([
      { type: "start", version: "0.1.70" },
      { type: "refused", reason: "Version 0.1.70 was refused: its signature didn't check out." },
    ]);
    expect(refused).toEqual({
      step: "refused",
      version: "0.1.70",
      reason: "Version 0.1.70 was refused: its signature didn't check out.",
    });
    // Not dismissed by anything else.
    expect(run([{ type: "deferred" }, { type: "restarting" }], refused)).toBe(refused);
    expect(run([{ type: "back" }], refused)).toEqual(IDLE);
  });

  it("an update that didn't start after restarting is refused too", () => {
    expect(
      run([
        { type: "start", version: "0.1.70" },
        { type: "restarting" },
        { type: "refused", reason: "The update didn't start." },
      ]),
    ).toMatchObject({ step: "refused" });
  });

  it("a busy runner sends it back to idle (it updates once idle)", () => {
    expect(
      run([{ type: "start", version: "0.1.70" }, { type: "waiting" }, { type: "deferred" }]),
    ).toEqual(IDLE);
  });

  it("ignores a second start, and events that don't apply where it is", () => {
    const verifying = run([{ type: "start", version: "0.1.70" }]);
    expect(applyTransition(verifying, { type: "start", version: "0.1.71" })).toBe(verifying);
    expect(applyTransition(IDLE, { type: "restarting" })).toBe(IDLE);
    expect(applyTransition(IDLE, { type: "refused", reason: "x" })).toBe(IDLE);
    expect(applyTransition(IDLE, { type: "back" })).toBe(IDLE);
  });
});

describe("what the window says", () => {
  it("names the step", () => {
    expect(applyStepText("verifying")).toBe("Checking the update's signature…");
    expect(applyStepText("restarting")).toBe("Restarting…");
  });

  it("marks the steps done, now and later", () => {
    expect(stepMarks("verifying")).toMatchObject({
      verifying: "now",
      waiting: "later",
      restarting: "later",
    });
    expect(stepMarks("restarting")).toMatchObject({
      verifying: "done",
      waiting: "done",
      restarting: "now",
    });
  });
});
