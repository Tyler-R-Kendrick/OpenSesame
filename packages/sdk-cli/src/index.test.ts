import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";
import { isFunction } from "@opensesame/os-domain";

describe("sdk-cli public exports", () => {
  it("re-exports the CLI-facing surface", () => {
    expect(isFunction(sdk.DeviceFlowClient)).toBe(true);
    expect(isFunction(sdk.redactSecrets)).toBe(true);
    expect(isFunction(sdk.loopbackLogin)).toBe(true);
    expect(isFunction(sdk.createControlPlaneClient)).toBe(true);
  });
});
