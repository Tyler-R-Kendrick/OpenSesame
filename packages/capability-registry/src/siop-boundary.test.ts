import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  mcpClientCatalog,
  mcpHostCatalog,
  webmcpCatalog,
  webmcpPagesCatalog,
} from "./index.js";

const SIOP = "identity.local.siop.authorize";

/**
 * A Self-Issued sign-in is the person's: a passkey check and a click on a page
 * only they can reach (ADR 0116, ADR 0161). Neither an agent over MCP or
 * WebMCP nor a CLI can approve one, and the one surface it has is the route.
 */
describe("SIOP consent is not an agent capability", () => {
  const capability = CAPABILITIES.find((entry) => entry.id === SIOP);

  it("is reachable only as the PWA route", () => {
    expect(capability?.surfaces).toEqual({
      cli: null,
      pwa: "route:/identity/siop",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    });
  });

  it("is absent from every agent catalog", () => {
    for (const catalog of [
      mcpHostCatalog(),
      mcpClientCatalog(),
      webmcpCatalog(),
      webmcpPagesCatalog(),
    ]) {
      expect(JSON.stringify(catalog)).not.toContain(SIOP);
      expect(JSON.stringify(catalog)).not.toMatch(/siop/i);
    }
  });

  it("excludes every agent surface with a reason that says why", () => {
    const excluded = capability?.excluded;
    for (const surface of ["mcp_host", "mcp_client", "webmcp"] as const) {
      expect(excluded?.[surface]?.reason, surface).toMatch(
        /human|passkey|cannot mint/i,
      );
    }
    expect(excluded?.cli?.adr).toBe(
      "0161-what-a-static-origin-can-be-as-an-openid-provider.md",
    );
  });

  it("is titled for what it is: SIOPv2, not a conventional OpenID provider", () => {
    expect(capability?.title).toMatch(/SIOPv2/);
    expect(capability?.title).toMatch(/Implementer's Draft/);
    expect(capability?.title).toMatch(/not a conventional OpenID Connect/);
  });
});
