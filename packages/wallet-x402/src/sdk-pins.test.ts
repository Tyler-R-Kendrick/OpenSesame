import { x402Version } from "@x402/core";
import { describe, expect, it } from "vitest";
import { X402_SDK_PINS, describeX402Adapter } from "./adapter.js";

describe("x402 SDK pins", () => {
  it("reports the pinned OSS packages and protocol version", () => {
    const manifest = describeX402Adapter();
    expect(manifest.sdkPins).toEqual(X402_SDK_PINS);
    expect(manifest.sdkPins.core).toBe("@x402/core@2.26.0");
    expect(manifest.sdkPins.evm).toBe("@x402/evm@2.26.0");
    expect(manifest.sdkPins.protocolVersion).toBe(x402Version);
    expect(manifest.productionEnabled).toBe(false);
    expect(manifest.evidenceStatus).toBe("blocked");
  });
});
