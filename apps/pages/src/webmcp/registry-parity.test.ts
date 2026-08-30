import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  assertsNoSecretNames,
  webmcpPagesCatalog,
} from "@opensesame/capability-registry";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { SECTION_PATHS, WEBMCP_TOOLS } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

const KNOWN_ROUTES = new Set<string>(["/", ...SECTION_PATHS]);

const LIB_SURFACE = /^lib\/(.+\.ts):(\w+)$/;

const libModules = import.meta.glob("../lib/**/*.ts");

describe("WebMCP registry parity (ADR 0065)", () => {
  it("implements exactly the registry-derived pages catalog", () => {
    const implemented = new Set(WEBMCP_TOOLS.map((tool) => tool.name));
    expect(implemented).toEqual(new Set(webmcpPagesCatalog()));
    expect(WEBMCP_TOOLS.length).toBe(implemented.size);
  });

  it("contains no secret-shaped tool name", () => {
    assertsNoSecretNames(WEBMCP_TOOLS.map((tool) => tool.name));
  });

  it("every lib/<file>.ts:<export> pwa surface resolves to a real export", async () => {
    const surfaces = CAPABILITIES.flatMap((capability) => {
      const match = capability.surfaces.pwa?.match(LIB_SURFACE);
      return match?.[1] && match[2]
        ? [{ id: capability.id, file: match[1], name: match[2] }]
        : [];
    });
    expect(surfaces.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      const load = libModules[`../lib/${surface.file}`];
      expect(
        load,
        `${surface.id} names missing module lib/${surface.file}`,
      ).toBeDefined();
      if (!load) continue;
      const module: JsonObject = overlapCast(await load());
      expect(
        surface.name in module,
        `${surface.id} names missing export lib/${surface.file}:${surface.name}`,
      ).toBe(true);
    }
  });

  it("every route: pwa surface is a real section route", () => {
    for (const capability of CAPABILITIES) {
      const surface = capability.surfaces.pwa;
      if (!surface?.startsWith("route:")) continue;
      const route = surface.slice("route:".length);
      expect(
        KNOWN_ROUTES.has(route),
        `${capability.id} names unknown route ${route}`,
      ).toBe(true);
    }
  });

  it("SECTION_PATHS mirrors the AppShell SECTIONS const", () => {
    const source = readFileSync(
      join(here, "..", "components", "AppShell.tsx"),
      "utf8",
    );
    for (const path of SECTION_PATHS) {
      expect(source).toContain(`to: "${path}"`);
    }
  });

  it("each pages capability is carried by the tool the registry names", () => {
    const byName = new Map(WEBMCP_TOOLS.map((tool) => [tool.name, tool]));
    for (const capability of CAPABILITIES) {
      const name = capability.surfaces.webmcp;
      if (!name || capability.surfaces.pwa?.startsWith("pwa-app:")) continue;
      const tool = byName.get(name);
      expect(tool, `no tool implements ${name}`).toBeDefined();
      expect(
        tool?.capabilityIds,
        `${name} does not declare ${capability.id}`,
      ).toContain(capability.id);
    }
  });
});
