import { describe, expect, it } from "vitest";
import {
  cardBrandByName,
  cardChecksumValid,
  detectCardBrand,
  formatCardNumber,
} from "./card.js";

describe("payment cards", () => {
  it("infers a brand only when the prefix, length and checksum agree", () => {
    expect(detectCardBrand("4111 1111 1111 1111")?.name).toBe("Visa");
    expect(detectCardBrand("5555555555554444")?.name).toBe("Mastercard");
    expect(detectCardBrand("378282246310005")?.name).toBe("American Express");
    expect(detectCardBrand("6011111111111117")?.name).toBe("Discover");
    expect(detectCardBrand("3530111333300000")?.name).toBe("JCB");
    expect(detectCardBrand("4111111111111112")).toBeNull();
    expect(detectCardBrand("1234567812345670")).toBeNull();
  });

  it("keeps a manual brand addressable by name", () => {
    expect(cardBrandByName("visa")?.id).toBe("visa");
    expect(cardBrandByName("American Express")?.id).toBe("amex");
    expect(cardBrandByName("My credit union")).toBeNull();
  });

  it("groups a number by the brand, and leaves an unknown one in fours", () => {
    expect(formatCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
    expect(formatCardNumber("378282246310005", "American Express")).toBe(
      "3782 822463 10005",
    );
    expect(formatCardNumber("1234567812345670")).toBe("1234 5678 1234 5670");
  });

  it("checks the checksum itself", () => {
    expect(cardChecksumValid("4111111111111111")).toBe(true);
    expect(cardChecksumValid("4111111111111112")).toBe(false);
    expect(cardChecksumValid("")).toBe(false);
  });
});
