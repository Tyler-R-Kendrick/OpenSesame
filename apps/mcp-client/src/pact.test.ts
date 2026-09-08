import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { assertsNoMaterializeTool, toolsManifest } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — mcp-client tools", () => {
  it("contract: catalog never advertises secret tools", () => {
    expect(() => assertsNoMaterializeTool(toolsManifest)).not.toThrow();
    expect(() =>
      assertsNoMaterializeTool([...toolsManifest, "getSecret"]),
    ).toThrow(/materialize_tools_forbidden/);
  });

  it("chaos: extra materialize aliases are refused", () => {
    for (const name of ["materialize_credential", "get_secret", "getSecret"]) {
      expect(() =>
        assertsNoMaterializeTool([...toolsManifest, name]),
      ).toThrow();
    }
  });

  it("Host URL is pinned before any tool runs", () => {
    assertSourceOrder(readFileSync(join(here, "server.ts"), "utf8"), [
      "function requireBase",
      "normalizeHttpBaseUrl(raw)",
      "throw new Error",
      "OPENSESAME_HOST_API",
    ]);
  });

  it("never acquires human Identity authority and guards every model response", () => {
    const source = readFileSync(join(here, "server.ts"), "utf8");
    expect(source).not.toContain("OPENSESAME_IDENTITY_TOKEN");
    expect(source).not.toContain("present_claim");
    expect(source).toContain("createAuthenticatedApiClient");
    expect(source).not.toContain(
      "accessToken ?? process.env.OPENSESAME_ACCESS_TOKEN",
    );
    assertSourceOrder(source, [
      "function modelText",
      "forAgent",
      "modelText(data)",
    ]);
  });
});
