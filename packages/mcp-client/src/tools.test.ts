import { describe, expect, it } from "vitest";
import { assertsNoMaterializeTool, toolsManifest } from "./tools.js";

describe("mcp-client tools", () => {
  it("never lists materialize", () => {
    expect(() => assertsNoMaterializeTool(toolsManifest)).not.toThrow();
  });
});
