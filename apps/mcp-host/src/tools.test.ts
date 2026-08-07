import { describe, expect, it } from "vitest";
import { assertsNoSecretTools, hostTools } from "./tools.js";

describe("mcp-host tools", () => {
  it("forbids secret tools", () => {
    expect(() => assertsNoSecretTools(hostTools)).not.toThrow();
  });
});
