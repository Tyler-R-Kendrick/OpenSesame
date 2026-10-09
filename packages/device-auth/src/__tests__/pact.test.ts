import { fixtures, overlapCast } from "@opensesame/os-domain";
import { assertNoSecretFields } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import {
  applySlowDown,
  initialPollInterval,
  projectDeviceAuth,
} from "../index.js";

describe("PACT — device-auth projection", () => {
  it("contract: UI projection has no secret fields", () => {
    const projection = projectDeviceAuth(fixtures.pendingDeviceAuth());
    assertNoSecretFields(overlapCast(projection));
    expect(JSON.stringify(projection)).not.toMatch(/user_code|device_code/i);
  });

  it("property: slow_down bumps stay finite", () => {
    let state = initialPollInterval(5);
    for (let i = 0; i < 20; i += 1) state = applySlowDown(state, 5);
    expect(state.intervalSeconds).toBe(60);
    expect(state.slowDownCount).toBe(20);
  });
});
