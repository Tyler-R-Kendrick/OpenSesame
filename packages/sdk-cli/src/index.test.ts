import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("sdk-cli public exports", () => {
  it("re-exports the CLI-facing surface", () => {
    expect(typeof sdk.DeviceFlowClient).toBe("function");
    expect(typeof sdk.redactSecrets).toBe("function");
    expect(typeof sdk.loopbackLogin).toBe("function");
    expect(typeof sdk.createControlPlaneClient).toBe("function");
  });
});
