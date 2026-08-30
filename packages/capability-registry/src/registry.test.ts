import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_SECRET_NAME_PATTERN,
  type AgentSurface,
  CAPABILITIES,
  assertsNoSecretNames,
  exclusionsFor,
  mcpClientCatalog,
  mcpHostCatalog,
  webmcpCatalog,
  webmcpPagesCatalog,
  webmcpPwaCatalog,
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

  it("webmcp catalog splits cleanly between pages and the thin pwa", () => {
    const pages = webmcpPagesCatalog();
    const pwa = webmcpPwaCatalog();
    expect([...pages, ...pwa].sort()).toEqual([...webmcpCatalog()].sort());
    for (const name of pwa) {
      expect(name).toMatch(/^opensesame_(pwa_|open_sign_in)/);
    }
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

  it("surface strings follow the documented conventions", () => {
    for (const capability of CAPABILITIES) {
      const { cli, pwa } = capability.surfaces;
      if (cli !== null) {
        expect(cli).toMatch(/^opensesame(-id)? [a-z]/);
      }
      if (pwa !== null) {
        expect(pwa).toMatch(
          /^(lib\/[\w/.-]+\.ts:\w+|route:\/[\w-]*|pwa-app:[\w-]+)$/,
        );
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
