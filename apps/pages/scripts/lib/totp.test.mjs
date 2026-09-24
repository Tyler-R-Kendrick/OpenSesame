import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { totp } from "./totp.mjs";

// ADR 0139: the harness computes the codes a person would type, so it must
// agree with the shared cases for the vault's parameters (SHA-1, 30 s).
const cases = JSON.parse(
  readFileSync(
    new URL("../../../../spec/conformance/otp-cases.json", import.meta.url),
    "utf8",
  ),
);

function vaultDefaults(uri) {
  if (!uri.includes(":")) return uri;
  const url = new URL(uri);
  const algorithm = url.searchParams.get("algorithm") ?? "SHA1";
  const period = url.searchParams.get("period") ?? "30";
  if (url.hostname !== "totp" || algorithm !== "SHA1" || period !== "30")
    return null;
  return url.searchParams.get("secret");
}

describe("verify-journey TOTP harness", () => {
  const usable = cases.codes.filter((c) => vaultDefaults(c.uri) !== null);

  it("has cases to check", () => {
    expect(usable.length).toBeGreaterThan(3);
  });

  for (const c of usable) {
    it(c.name, () => {
      // Six digits: the low six of an eight-digit code are the six-digit code.
      expect(totp(vaultDefaults(c.uri), c.atSeconds * 1000)).toBe(
        c.code.slice(-6),
      );
    });
  }
});
