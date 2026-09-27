import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("the MCP skill lists exactly toolsManifest", () => {
    expect(skillTools("Client tools").sort()).toEqual(
      [...toolsManifest].sort(),
    );
  });
});

/** The backticked tool names listed under `### <heading>` in the MCP skill. */
function skillTools(heading: string): string[] {
  const skill = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../skills/opensesame-mcps/SKILL.md",
    ),
    "utf8",
  );
  const start = skill.indexOf(`### ${heading}`);
  if (start < 0) throw new Error(`skill has no "${heading}" list`);
  const rest = skill.slice(start);
  const end = rest.indexOf("\n\n", rest.indexOf("\n- "));
  const list = end < 0 ? rest : rest.slice(0, end);
  return Array.from(list.matchAll(/^- `([a-z0-9_]+)`/gm), (m) => m[1] ?? "");
}
