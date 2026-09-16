import { describe, expect, it } from "vitest";
import { safeMerchantLabel } from "./wallet-safe-label.js";

describe("safeMerchantLabel (WAL-B06)", () => {
  it("strips HTML/script-looking markup", () => {
    expect(safeMerchantLabel("<img src=x onerror=alert(1)>Cafe")).toBe(
      "img src=x onerror=alert(1)Cafe",
    );
    expect(safeMerchantLabel("Cafe<script>alert(1)</script>")).toBe(
      "Cafescriptalert(1)/script",
    );
  });

  it("strips bidi overrides that could hide trailing amount digits", () => {
    const hostile = "Cafe\u202E999\u202C";
    const safe = safeMerchantLabel(hostile);
    expect(safe).toBe("Cafe999");
    expect(safe).not.toMatch(/[\u202A-\u202E]/u);
  });

  it("never returns empty — keeps a placeholder so amount stays contextual", () => {
    expect(safeMerchantLabel("   ")).toBe("(unnamed merchant)");
    expect(safeMerchantLabel("\u202E\u202C")).toBe("(unnamed merchant)");
  });
});
