/**
 * The embedded mailbox type is the marketplace file, byte for byte. The JSON
 * under `marketplace/item-types/optional/` is the one source (the Rust
 * conformance suite and the marketplace pin read the same bytes); this module
 * is generated from it by `pnpm --filter @opensesame/app-core
 * generate:reset-mail-types`, and fails here when it has drifted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderModule } from "../../../scripts/emit-reset-mail-types.mjs";
import { RESET_MAIL_TYPES } from "./mail-type.generated.js";

const optional = (id: string) =>
  readFileSync(
    new URL(
      `../../../../../marketplace/item-types/optional/${id}.json`,
      import.meta.url,
    ),
    "utf8",
  );

describe("the embedded reset mailbox type", () => {
  it("is the one type the mailboxes are kept in", () => {
    expect(RESET_MAIL_TYPES.map((type) => type.id)).toEqual(["email-account"]);
  });

  for (const type of RESET_MAIL_TYPES) {
    it(`${type.id}: the text equals the marketplace file byte for byte`, () => {
      expect(type.text).toBe(optional(type.id));
    });

    it(`${type.id}: the version equals the one the file declares`, () => {
      expect(type.version).toBe(JSON.parse(optional(type.id)).metadata.version);
    });
  }

  it("is what the generator writes (before formatting)", () => {
    const text = renderModule();
    for (const type of RESET_MAIL_TYPES) {
      expect(text).toContain(JSON.stringify(type.text));
      expect(text).toContain(JSON.stringify(type.version));
    }
  });
});
