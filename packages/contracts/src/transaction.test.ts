import { describe, expect, it } from "vitest";
import {
  MonetaryAmountSchema,
  PaymentInitiationDetailSchema,
  TransactionDisplaySchema,
  TransactionPayeeSchema,
} from "./transaction.js";

/**
 * Swarm D — positive transaction/display contracts (ADR 0086 §6).
 *
 * os-domain's card-data guard refuses by deny-list; these schemas refuse by
 * omission. The two are complements, and this suite pins the positive half:
 * an amount is a bounded decimal string, a payee and an amount carry nothing
 * but their named fields, and the approval display cannot render a field that
 * was never part of what gets hashed.
 */

describe("MonetaryAmountSchema", () => {
  it("accepts a bounded decimal string with an ISO currency", () => {
    expect(
      MonetaryAmountSchema.safeParse({ currency: "USD", value: "143.72" })
        .success,
    ).toBe(true);
  });

  it("refuses a numeric amount that cannot round-trip", () => {
    expect(
      MonetaryAmountSchema.safeParse({ currency: "USD", value: 143.72 })
        .success,
    ).toBe(false);
  });

  const badValues = ["", "-1", "1.234567", "1e3", "143,72", "abc"];
  for (const value of badValues) {
    it(`refuses the value ${JSON.stringify(value)}`, () => {
      expect(
        MonetaryAmountSchema.safeParse({ currency: "USD", value }).success,
      ).toBe(false);
    });
  }

  for (const currency of ["usd", "US", "USDT", ""]) {
    it(`refuses the currency ${JSON.stringify(currency)}`, () => {
      expect(
        MonetaryAmountSchema.safeParse({ currency, value: "1.00" }).success,
      ).toBe(false);
    });
  }

  it("refuses an extra member where a PAN could hide", () => {
    expect(
      MonetaryAmountSchema.safeParse({
        currency: "USD",
        value: "1.00",
        pan: "4111111111111111",
      }).success,
    ).toBe(false);
  });
});

describe("TransactionPayeeSchema", () => {
  it("accepts a bounded display name", () => {
    expect(
      TransactionPayeeSchema.safeParse({ display_name: "Vendor" }).success,
    ).toBe(true);
  });

  it("refuses an empty or over-long name and any extra member", () => {
    expect(TransactionPayeeSchema.safeParse({ display_name: "" }).success).toBe(
      false,
    );
    expect(
      TransactionPayeeSchema.safeParse({ display_name: "V".repeat(141) })
        .success,
    ).toBe(false);
    expect(
      TransactionPayeeSchema.safeParse({
        display_name: "V",
        cardNumber: "4111111111111111",
      }).success,
    ).toBe(false);
  });
});

describe("PaymentInitiationDetailSchema", () => {
  it("accepts a well-formed instruction and keeps RFC 9396 extensions", () => {
    const parsed = PaymentInitiationDetailSchema.parse({
      type: "payment_initiation",
      amount: { currency: "USD", value: "143.72" },
      payee: { display_name: "Vendor" },
      locations: ["https://bank.example"],
    });
    expect(parsed.type).toBe("payment_initiation");
    // The detail stays open so the digest covers extension members.
    expect("locations" in parsed).toBe(true);
  });

  it("refuses a wrong type or a malformed amount", () => {
    expect(
      PaymentInitiationDetailSchema.safeParse({
        type: "claim_resource",
        amount: { currency: "USD", value: "1.00" },
        payee: { display_name: "V" },
      }).success,
    ).toBe(false);
    expect(
      PaymentInitiationDetailSchema.safeParse({
        type: "payment_initiation",
        amount: { currency: "usd", value: "1.00" },
        payee: { display_name: "V" },
      }).success,
    ).toBe(false);
  });
});

describe("TransactionDisplaySchema", () => {
  it("accepts a bound display with an amount and payee", () => {
    expect(
      TransactionDisplaySchema.safeParse({
        bindingMessage: "Pay 143.72 USD to Vendor",
        amount: { currency: "USD", value: "143.72" },
        payee: { display_name: "Vendor" },
        operationDigest: `sha256:${"a".repeat(64)}`,
      }).success,
    ).toBe(true);
  });

  it("accepts a non-payment display with no amount", () => {
    expect(
      TransactionDisplaySchema.safeParse({
        bindingMessage: "read on conn_1",
        operationDigest: `sha256:${"a".repeat(64)}`,
      }).success,
    ).toBe(true);
  });

  it("refuses a display carrying a field that never gets hashed", () => {
    expect(
      TransactionDisplaySchema.safeParse({
        bindingMessage: "Pay 143.72 USD to Vendor",
        operationDigest: `sha256:${"a".repeat(64)}`,
        extraCallToAction: "click here",
      }).success,
    ).toBe(false);
  });
});
