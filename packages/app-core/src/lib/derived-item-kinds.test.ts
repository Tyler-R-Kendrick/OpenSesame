import { builtinDefinitions } from "@opensesame/vault-item-types";
import { describe, expect, it } from "vitest";
import { DERIVED_ITEM_KINDS } from "./derived-item-kinds.js";

const ELSEWHERE = new Set(["passkey", "certificate", "drop"]);

describe("derived item kinds", () => {
  it("treats every built-in type other than secret as a projection onto it", () => {
    const derived = new Set(DERIVED_ITEM_KINDS);
    for (const definition of builtinDefinitions()) {
      const id = definition.metadata.id;
      expect(definition.spec.native).toBeDefined();
      if (id === "secret") {
        expect(definition.spec.native.secret).toBe("value");
        expect(derived.has(id)).toBe(false);
        continue;
      }
      expect(derived.has(id) || ELSEWHERE.has(id), id).toBe(true);
    }
  });
});
