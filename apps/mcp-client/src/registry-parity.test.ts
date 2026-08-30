import {
  assertsNoSecretNames,
  mcpClientCatalog,
} from "@opensesame/capability-registry";
import { describe, expect, it } from "vitest";
import { assertsNoMaterializeTool, toolsManifest } from "./tools.js";

describe("registry parity — mcp-client", () => {
  it("implements exactly the registry's mcp_client catalog", () => {
    const implemented = new Set<string>([...toolsManifest]);
    const demanded = new Set<string>([...mcpClientCatalog()]);
    expect([...implemented].sort()).toEqual([...demanded].sort());
    for (const name of demanded) {
      expect(implemented.has(name), `missing tool: ${name}`).toBe(true);
    }
    for (const name of implemented) {
      expect(demanded.has(name), `undeclared tool: ${name}`).toBe(true);
    }
  });

  it("the grown manifest still passes both secret-name fences", () => {
    expect(() => assertsNoMaterializeTool(toolsManifest)).not.toThrow();
    expect(() => assertsNoSecretNames(toolsManifest)).not.toThrow();
  });
});
