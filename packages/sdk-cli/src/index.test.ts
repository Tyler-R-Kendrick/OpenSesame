import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("sdk-cli public exports", () => {
  it("re-exports the CLI-facing surface", () => {
    expect(sdk.DeviceFlowClient).toBeTypeOf("function");
    expect(sdk.redactSecrets).toBeTypeOf("function");
    expect(sdk.loopbackLogin).toBeTypeOf("function");
    expect(sdk.createControlPlaneClient).toBeTypeOf("function");
  });
});
