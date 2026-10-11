import { describe, expect, it } from "vitest";
import { publicRelayBuildDefault } from "./public-relay-default.js";

describe("publicRelayBuildDefault", () => {
  it("is empty when the build did not stamp a relay URL", () => {
    expect(publicRelayBuildDefault().relayApiOrigin).toBe("");
  });
});
