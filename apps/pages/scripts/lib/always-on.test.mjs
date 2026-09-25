import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALWAYS_ON_TITLES } from "./always-on.mjs";

describe("ALWAYS_ON_TITLES", () => {
  it("names exactly the always-on descriptors of the catalog", () => {
    const source = ["catalog-always-on.ts", "catalog-always-on-local.ts"]
      .map((file) =>
        readFileSync(
          new URL(
            `../../../../packages/app-core/src/lib/capabilities/${file}`,
            import.meta.url,
          ),
          "utf8",
        ),
      )
      .join("\n");
    const titles = [
      ...source.matchAll(/alwaysOn\(\s*"[^"]+",\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(new Set(titles)).toEqual(ALWAYS_ON_TITLES);
  });
});
