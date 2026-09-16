import {
  assertsNoInteractionSettlementTool,
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

  it("carries no tool that settles an interaction or mints a proof (ADR 0086)", () => {
    // Finding S12 / T-34: the client CLI/SDK plane drives the RFC 8628 device
    // flow but never approves an interaction or produces a human proof.
    expect(() =>
      assertsNoInteractionSettlementTool(toolsManifest),
    ).not.toThrow();
  });
});
