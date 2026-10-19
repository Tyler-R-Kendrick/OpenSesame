import { describe, expect, it } from "vitest";
import { mintUserCode } from "./local-drop-codec.js";

describe("mintUserCode", () => {
  it("mints XXXX-XXXX codes drawn only from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(mintUserCode()).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
      );
    }
  });
});
