import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderModule, specPath } from "../scripts/emit-endpoints.mjs";
import { ENDPOINTS_JSON } from "./endpoints.generated.js";
import {
  ENDPOINTS,
  type EndpointId,
  endpointAddress,
  endpointListen,
  variableNames,
} from "./endpoints.js";

const root = join(specPath, "../../..");

describe("endpoints (ADR 0139)", () => {
  it("embeds spec/config/endpoints.json as it is", () => {
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    expect(JSON.parse(ENDPOINTS_JSON)).toEqual(spec.endpoints);
    expect(renderModule()).toContain(JSON.stringify(ENDPOINTS_JSON));
  });

  it("resolves the variable, then its aliases in order, then the default", () => {
    const host = ENDPOINTS.host;
    const [alias] = host.aliases;
    expect(alias).toBeDefined();
    expect(endpointAddress("host", {})).toBe(host.default);
    expect(endpointAddress("host", { [alias ?? ""]: "http://alias" })).toBe(
      "http://alias",
    );
    expect(
      endpointAddress("host", {
        [host.env]: "http://set",
        [alias ?? ""]: "http://alias",
      }),
    ).toBe("http://set");
    expect(endpointAddress("host", { [host.env]: "  " })).toBe(host.default);
    expect(endpointListen("daemon", {})).toBe(ENDPOINTS.daemon.listen.default);
  });

  it("no source file reads an alias directly", () => {
    const aliases = (Object.keys(ENDPOINTS) as EndpointId[])
      .flatMap((id) => [
        ...ENDPOINTS[id].aliases,
        ...ENDPOINTS[id].listen.aliases,
      ])
      .filter((name) => name.startsWith("OPENSESAME_"));
    const pattern = `\\b(${aliases.join("|")})\\b`;
    let hits = "";
    try {
      hits = execFileSync(
        "git",
        [
          "grep",
          "-nE",
          pattern,
          "--",
          ".",
          ":!*.md",
          ":!spec/config/endpoints.json",
          ":!packages/os-domain/src/endpoints.generated.ts",
          ":!docs",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      hits = ""; // git grep exits 1 when nothing matches
    }
    expect(
      hits,
      "resolve these through the endpoints module (os-domain or host-core)",
    ).toBe("");
  });

  it("names every endpoint the same way on every surface", () => {
    for (const [id, e] of Object.entries(ENDPOINTS)) {
      const upper = id.toUpperCase();
      expect(e.env).toBe(`OPENSESAME_${upper}_API`);
      expect(e.pagesRuntimeKey).toBe(`PAGES_${upper}_API`);
      expect(e.viteKey).toBe(`VITE_${upper}_API`);
      expect(e.setting).toBe(`${id}Api`);
      expect(variableNames(e)[0]).toBe(e.env);
    }
  });
});
