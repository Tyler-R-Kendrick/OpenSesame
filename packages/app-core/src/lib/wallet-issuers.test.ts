import { describe, expect, it } from "vitest";
import {
  connectedWalletIssuerIds,
  isWalletIssuer,
  temporaryCardsAvailable,
} from "./wallet-issuers.js";

describe("wallet issuers", () => {
  it("recognizes catalog wallet issuers only", () => {
    expect(isWalletIssuer("privacy")).toBe(true);
    expect(isWalletIssuer("stripe")).toBe(false);
  });

  it("offers temporary cards only when an issuer is connected", () => {
    expect(temporaryCardsAvailable([])).toBe(false);
    expect(
      temporaryCardsAvailable([
        { providerId: "stripe", status: "active" },
        { providerId: "privacy", status: "revoked" },
      ]),
    ).toBe(false);
    expect(
      connectedWalletIssuerIds([
        { providerId: "lithic", status: "active" },
        { providerId: "privacy", status: "active" },
      ]),
    ).toEqual(["privacy", "lithic"]);
    expect(
      temporaryCardsAvailable([{ providerId: "marqeta", status: "active" }]),
    ).toBe(true);
    expect(
      temporaryCardsAvailable([
        { providerId: "privacy", status: "pending" },
        { providerId: "lithic", status: "expired" },
        { providerId: "marqeta", status: "error" },
      ]),
    ).toBe(false);
  });
});
