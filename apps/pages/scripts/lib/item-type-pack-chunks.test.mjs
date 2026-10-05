import { describe, expect, it } from "vitest";
import { itemTypePackChunk } from "./item-type-pack-chunks.mjs";

describe("item-type pack chunks", () => {
  it("names one chunk per pack module", () => {
    expect(
      itemTypePackChunk(
        "/repo/packages/vault-item-types/src/packs/wifi.generated.ts",
      ),
    ).toBe("item-type-pack-wifi");
    expect(
      itemTypePackChunk(
        "C:\\repo\\packages\\vault-item-types\\src\\packs\\ssh-key.generated.ts",
      ),
    ).toBe("item-type-pack-ssh-key");
  });

  it("leaves the index and the embedded core where they are", () => {
    for (const id of [
      "/repo/packages/vault-item-types/src/packs.generated.ts",
      "/repo/packages/vault-item-types/src/definitions.generated.ts",
      "/repo/packages/vault-item-types/src/packs.ts",
    ]) {
      expect(itemTypePackChunk(id)).toBeUndefined();
    }
  });
});
