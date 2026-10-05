import { describe, expect, it } from "vitest";
import { assertNoStructuralLeak } from "./egress.js";

describe("an account's login-method secrets (ADR 0172)", () => {
  it("refuses every key a method keeps a secret under", () => {
    for (const key of [
      "pepper",
      "sealed",
      "oprfKeyB64",
      "apiKey",
      "clientSecret",
      "refreshToken",
    ]) {
      expect(() => assertNoStructuralLeak({ [key]: "x" })).toThrow(/refused/);
    }
  });
});
