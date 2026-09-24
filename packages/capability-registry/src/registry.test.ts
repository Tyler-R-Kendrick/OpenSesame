import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_SECRET_NAME_PATTERN,
  type AgentSurface,
  CAPABILITIES,
  INTERACTION_SETTLEMENT_PATTERN,
  assertsNoInteractionSettlementTool,
  assertsNoSecretNames,
  exclusionsFor,
  mcpClientCatalog,
  mcpHostCatalog,
  webmcpCatalog,
  webmcpPagesCatalog,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const AGENT_SURFACES: readonly AgentSurface[] = [
  "mcp_host",
  "mcp_client",
  "webmcp",
];

describe("capability registry shape", () => {
  it("capability ids are unique and dot-namespaced", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it("a surface is never both mapped and excluded", () => {
    for (const capability of CAPABILITIES) {
      for (const surface of AGENT_SURFACES) {
        if (capability.excluded?.[surface]) {
          expect(
            capability.surfaces[surface],
            `${capability.id} maps and excludes ${surface}`,
          ).toBeNull();
        }
      }
    }
  });

  it("every exclusion cites an ADR file that exists", () => {
    for (const capability of CAPABILITIES) {
      for (const surface of AGENT_SURFACES) {
        const exclusion = capability.excluded?.[surface];
        if (!exclusion) {
          continue;
        }
        expect(exclusion.reason.length).toBeGreaterThan(10);
        const adrPath = join(repoRoot, "docs", "adr", exclusion.adr);
        expect(
          existsSync(adrPath),
          `${capability.id} cites missing ADR ${exclusion.adr}`,
        ).toBe(true);
      }
    }
  });
});

describe("agent-surface parity rules", () => {
  it("every host/identity capability is MCP-mapped or MCP-excluded", () => {
    for (const capability of CAPABILITIES) {
      if (capability.plane === "client_local") {
        continue;
      }
      const mapped =
        capability.surfaces.mcp_host !== null ||
        capability.surfaces.mcp_client !== null;
      const excluded = Boolean(
        capability.excluded?.mcp_host ?? capability.excluded?.mcp_client,
      );
      expect(
        mapped || excluded,
        `${capability.id} is neither reachable from MCP nor excluded with a reason`,
      ).toBe(true);
    }
  });

  it("every capability with a PWA surface is WebMCP-mapped or -excluded", () => {
    for (const capability of CAPABILITIES) {
      if (capability.surfaces.pwa === null) {
        continue;
      }
      const covered =
        capability.surfaces.webmcp !== null ||
        Boolean(capability.excluded?.webmcp);
      expect(
        covered,
        `${capability.id} ships in the PWA but WebMCP neither carries nor excludes it`,
      ).toBe(true);
    }
  });

  it("no agent catalog carries a secret-shaped tool name", () => {
    expect(() => assertsNoSecretNames(mcpHostCatalog())).not.toThrow();
    expect(() => assertsNoSecretNames(mcpClientCatalog())).not.toThrow();
    expect(() => assertsNoSecretNames(webmcpCatalog())).not.toThrow();
    expect(() => assertsNoSecretNames(["secret_config_read"])).toThrow(
      "secret_tools_forbidden",
    );
    expect(AGENT_SECRET_NAME_PATTERN.test("pass_show")).toBe(true);
  });

  it("the pages webmcp catalog is the whole webmcp catalog", () => {
    expect([...webmcpPagesCatalog()]).toEqual([...webmcpCatalog()]);
  });

  it("reveal-gated surfaces stay excluded everywhere agents run", () => {
    for (const id of [
      "secrets.materialize",
      "sealed_store.pass",
      "configs.values.read",
      "vault.totp.seed",
    ]) {
      const capability = CAPABILITIES.find((c) => c.id === id);
      expect(capability, `registry lost exclusion entry ${id}`).toBeDefined();
      expect(capability?.surfaces.mcp_host).toBeNull();
      expect(capability?.surfaces.mcp_client).toBeNull();
      expect(capability?.surfaces.webmcp).toBeNull();
      expect(capability?.excluded?.webmcp).toBeDefined();
    }
    expect(exclusionsFor("mcp_host").length).toBeGreaterThanOrEqual(10);
  });

  it("cross-device interaction settlement stays excluded on every agent surface (ADR 0086)", () => {
    // Finding S12 / T-34: the server mints the canonical interaction and a
    // human authenticator mints its proof. No agent surface may create, approve
    // or deny one — a tool that could would remove the only step that makes the
    // answer mean anything.
    const ADR_INTERACTION = "0086-wallet-native-interaction-layer.md";
    for (const id of [
      "identity.interaction.create",
      "identity.interaction.approve",
      "identity.interaction.deny",
    ]) {
      const capability = CAPABILITIES.find((c) => c.id === id);
      expect(capability, `registry lost interaction entry ${id}`).toBeDefined();
      for (const surface of AGENT_SURFACES) {
        expect(
          capability?.surfaces[surface],
          `${id} must not be mapped on ${surface}`,
        ).toBeNull();
        expect(
          capability?.excluded?.[surface]?.adr,
          `${id} must cite ${ADR_INTERACTION} on ${surface}`,
        ).toBe(ADR_INTERACTION);
      }
    }
  });

  it("no agent catalog names a tool that settles an interaction or mints a proof", () => {
    for (const catalog of [
      mcpHostCatalog(),
      mcpClientCatalog(),
      webmcpCatalog(),
    ]) {
      expect(() => assertsNoInteractionSettlementTool(catalog)).not.toThrow();
    }
    // The fence bites the shapes the finding names, and leaves the humane
    // "open a ceremony" tools (which settle nothing) alone.
    expect(INTERACTION_SETTLEMENT_PATTERN.test("approve_interaction")).toBe(
      true,
    );
    expect(INTERACTION_SETTLEMENT_PATTERN.test("mint_approval_proof")).toBe(
      true,
    );
    expect(() =>
      assertsNoInteractionSettlementTool(["deny_interaction"]),
    ).toThrow("interaction_settlement_tools_forbidden");
    expect(
      INTERACTION_SETTLEMENT_PATTERN.test("opensesame_open_relay_approval"),
    ).toBe(false);
    expect(
      INTERACTION_SETTLEMENT_PATTERN.test("opensesame_open_delegation_claim"),
    ).toBe(false);
  });

  it("in-product guidance ships on WebMCP and stays off headless MCP", () => {
    for (const [id, tool] of [
      ["client.support", "opensesame_help"],
      ["client.tutorial", "opensesame_guide_start"],
    ]) {
      const capability = CAPABILITIES.find((c) => c.id === id);
      expect(capability, `registry lost guidance entry ${id}`).toBeDefined();
      expect(capability?.plane).toBe("client_local");
      expect(capability?.kind).toBe("read");
      expect(capability?.surfaces.webmcp).toBe(tool);
      expect(capability?.surfaces.cli).toBeNull();
      expect(capability?.surfaces.mcp_host).toBeNull();
      expect(capability?.surfaces.mcp_client).toBeNull();
      for (const surface of ["mcp_host", "mcp_client"] as const) {
        expect(
          capability?.excluded?.[surface]?.adr,
          `${id} must cite the contextual-support ADR on ${surface}`,
        ).toBe("0088-ai-native-contextual-support.md");
      }
    }
  });

  it("surface strings follow the documented conventions", () => {
    for (const capability of CAPABILITIES) {
      const { cli, pwa } = capability.surfaces;
      if (cli !== null) {
        expect(cli).toMatch(/^opensesame(-id)? [a-z]/);
      }
      if (pwa !== null) {
        expect(pwa).toMatch(PWA_SURFACE);
      }
    }
  });
});

const PWA_SURFACE =
  /^((?:lib|vault-core)\/[\w/.-]+\.ts:\w+|route:\/(?:[\w-]+(?:\/[\w-]+)*)?)$/;
it("admits exact nested routes without URL or path ambiguity", () => {
  for (const route of [
    "route:/",
    "route:/identity",
    "route:/identity/authorize",
  ])
    expect(route).toMatch(PWA_SURFACE);
  for (const route of [
    "route://identity",
    "route:/identity/",
    "route:/identity/../vault",
    "route:/identity?x=1",
    "route:/identity#x",
    "route:https://example.test",
    "route:/identity%2fauthorize",
  ])
    expect(route).not.toMatch(PWA_SURFACE);
});

describe("generalized hierarchical authority parity", () => {
  it("Every authority capability maps or ADR-excludes all four agent surfaces", () => {
    const authority = CAPABILITIES.filter((capability) =>
      capability.id.startsWith("authority."),
    );
    expect(authority.length).toBeGreaterThan(0);
    for (const capability of authority) {
      // Agent surfaces under ADR 0065: mcp_host, mcp_client, webmcp, plus cli.
      for (const surface of [...AGENT_SURFACES, "cli"] as const) {
        const mapped = capability.surfaces[surface];
        const excluded = capability.excluded?.[surface];
        const mappedOk =
          mapped !== null && mapped !== undefined && excluded === undefined;
        const excludedOk =
          (mapped === null || mapped === undefined) &&
          Boolean(excluded?.adr && excluded.reason);
        expect(mappedOk || excludedOk).toBe(true);
      }
    }
  });
});

describe("capabilities.json mirror", () => {
  it("matches the TypeScript source of truth", () => {
    const raw = readFileSync(join(here, "..", "capabilities.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(CAPABILITIES)));
  });
});
