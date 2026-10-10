/**
 * The embedded item types are the marketplace files, byte for byte. The JSON
 * under `marketplace/item-types/optional/` is the one source (the Rust
 * conformance suite and the marketplace pin read the same bytes); this module
 * is generated from it by `pnpm --filter @opensesame/app-core
 * generate:quorum-types`, and fails here when it has drifted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderModule } from "../../../scripts/emit-quorum-types.mjs";
import { QUORUM_TYPES } from "./item-types.generated.js";
import { GUARDIAN_SHARE_TYPE, TRUSTED_CIRCLE_TYPE } from "./records.js";

const optional = (id: string) =>
  readFileSync(
    new URL(
      `../../../../../marketplace/item-types/optional/${id}.json`,
      import.meta.url,
    ),
    "utf8",
  );

describe("the embedded quorum item types", () => {
  it("are the two types the records are kept in", () => {
    expect(QUORUM_TYPES.map((type) => type.id)).toEqual([
      TRUSTED_CIRCLE_TYPE,
      GUARDIAN_SHARE_TYPE,
    ]);
  });

  for (const type of QUORUM_TYPES) {
    it(`${type.id}: the text equals the marketplace file byte for byte`, () => {
      expect(type.text).toBe(optional(type.id));
    });

    it(`${type.id}: the version equals the one the file declares`, () => {
      expect(type.version).toBe(JSON.parse(optional(type.id)).metadata.version);
    });
  }

  it("is what the generator writes (before formatting)", () => {
    const text = renderModule();
    for (const type of QUORUM_TYPES) {
      expect(text).toContain(JSON.stringify(type.text));
      expect(text).toContain(JSON.stringify(type.version));
    }
  });
});
