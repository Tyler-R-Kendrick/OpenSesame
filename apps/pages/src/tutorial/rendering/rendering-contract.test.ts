import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GuideRenderer } from "@opensesame/guide-runtime";
import { describe, expect, it } from "vitest";
import {
  type DriverRendererOptions,
  createDriverRenderer,
  loadDriverRenderer,
} from "./driver-renderer.js";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const SOURCES = ["annotation.ts", "driver-renderer.ts", "index.ts"] as const;

/** Selectors that open a rule at the top level or inside an at-rule. */
function ruleSelectors(css: string): string[] {
  const source = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const selectors: string[] = [];
  let buffer = "";
  for (const character of source) {
    if (character === "{") {
      const text = buffer.trim();
      buffer = "";
      if (text.length === 0 || text.startsWith("@")) continue;
      for (const part of text.split(",")) selectors.push(part.trim());
      continue;
    }
    if (character === "}") {
      buffer = "";
      continue;
    }
    buffer += character;
  }
  return selectors;
}

describe("the rendering module's boundary", () => {
  it("keeps Driver.js out of the static import graph", () => {
    for (const name of SOURCES) {
      expect(read(name)).not.toMatch(
        /import\s+(?:type\s+)?[^;]*from\s*["']driver\.js/,
      );
    }
    expect(read("driver-renderer.ts")).toContain('import("driver.js")');
    expect(read("driver-renderer.ts")).toContain('import("driver.js/hints")');
    expect(read("driver-renderer.ts")).toContain('import("./driver.css")');
  });

  it("exports OpenSesame values only", async () => {
    const barrel = await import("./index.js");
    expect(Object.keys(barrel).sort()).toEqual([
      "ANNOTATION_ATTRIBUTE",
      "createDriverRenderer",
      "createGuideAnnotation",
      "loadDriverRenderer",
    ]);

    // Type-level: the public surface is stated entirely in OpenSesame types.
    const create: (options: DriverRendererOptions) => GuideRenderer =
      createDriverRenderer;
    const load: (options: DriverRendererOptions) => Promise<GuideRenderer> =
      loadDriverRenderer;
    expect(create).toBe(createDriverRenderer);
    expect(load).toBe(loadDriverRenderer);
  });

  it("scopes every stylesheet rule to the guide", () => {
    const selectors = ruleSelectors(read("driver.css"));
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
      expect(selector).toMatch(/^\.(os-guide|driver-)/);
      for (const part of selector.split(/[\s>+~]+/)) {
        expect(part).not.toMatch(/^(?:button|input|a|\.btn|\.chip|\.go)\b/);
      }
    }
  });
});
