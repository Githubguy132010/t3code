import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CloudExecutionCommand, CloudExecutionSnapshot } from "./cloudExecution.ts";
describe("cloud execution contracts", () => {
  it("accepts only the bounded free resume contract", () => {
    const valid = Schema.is(CloudExecutionCommand);
    expect(
      valid({ action: "resume", confirmedFree: true, maxExtraUsd: 0, durationSeconds: 1800 }),
    ).toBe(true);
    expect(
      valid({ action: "resume", confirmedFree: true, maxExtraUsd: 1, durationSeconds: 1800 }),
    ).toBe(false);
    expect(
      valid({ action: "resume", confirmedFree: true, maxExtraUsd: 0, durationSeconds: 3600 }),
    ).toBe(false);
    expect(valid({ action: "attach", boxId: "../other", apiKey: "dummy-pilot-only" })).toBe(false);
  });
  it("models unconfirmed pause separately from completed pause", () => {
    expect(
      Schema.is(CloudExecutionSnapshot)({
        boxId: "selected-box",
        phase: "pausing",
        deadline: 123,
        pauseAttempts: 1,
      }),
    ).toBe(true);
  });
});
