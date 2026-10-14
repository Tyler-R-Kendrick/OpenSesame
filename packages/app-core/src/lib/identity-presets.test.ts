import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { IDENTITY_CONNECTION_PRESETS } from "./identity-connections-presets.js";

it("every partner experience uses the generated shared protocol definition", () => {
  const source = JSON.parse(
    readFileSync(
      new URL(
        "../../../../spec/connectors/identity-presets.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(IDENTITY_CONNECTION_PRESETS).toEqual(source.providers);
  expect(
    new Set(IDENTITY_CONNECTION_PRESETS.map((preset) => preset.id)).size,
  ).toBe(IDENTITY_CONNECTION_PRESETS.length);
});
