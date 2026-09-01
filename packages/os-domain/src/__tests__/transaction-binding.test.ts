import { describe, expect, it } from "vitest";
import {
  type AuthorizationDetail,
  assertAuthorizationDetails,
  assertNoPaymentCredentials,
  assertPaymentInitiation,
  deriveBindingMessage,
} from "../authorization-details.js";
import {
  type CanonicalRequest,
  canonicalRequestDigest,
  digestMatches,
} from "../crypto/request-digest.js";
import { DomainError } from "../errors.js";
import {
  type JsonObject,
  type JsonValue,
  type MutableBoundaryObject,
  overlapCast,
} from "../json.js";

function payment(overrides: JsonObject = {}): AuthorizationDetail {
  return {
    type: "payment_initiation",
    amount: { currency: "USD", value: "143.72" },
    payee: { display_name: "Example Vendor" },
    ...overrides,
  };
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    kind: "transaction_authorization",
    subject: "transaction_authorization:txn_1",
    approverRef: "inbox_abc.def",
    requesterRef: "req_xyz",
    authorizationDetails: [payment()],
    bindingMessage: "Pay 143.72 USD to Example Vendor",
    expiresAt: "2026-08-31T12:05:00.000Z",
    ...overrides,
  };
}

describe("canonical request digest", () => {
  it("is stable across key order and object identity", () => {
    const a = canonicalRequestDigest(request());
    const b = canonicalRequestDigest(
      request({
        authorizationDetails: [
          {
            payee: { display_name: "Example Vendor" },
            amount: { value: "143.72", currency: "USD" },
            type: "payment_initiation",
          },
        ],
      }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // Every entry here is a change a user would notice on the screen. If any of
  // them left the digest alone, an approval for one operation would settle a
  // different one.
  const mutations: ReadonlyArray<[string, Partial<CanonicalRequest>]> = [
    [
      "the amount",
      {
        authorizationDetails: [
          payment({ amount: { currency: "USD", value: "143.73" } }),
        ],
      },
    ],
    [
      "the currency",
      {
        authorizationDetails: [
          payment({ amount: { currency: "EUR", value: "143.72" } }),
        ],
      },
    ],
    [
      "the payee",
      {
        authorizationDetails: [
          payment({ payee: { display_name: "Vendor B" } }),
        ],
      },
    ],
    ["the operation kind", { kind: "authorization_request" }],
    ["the ceremony it settles", { subject: "transaction_authorization:txn_2" }],
    ["the approver", { approverRef: "inbox_someone.else" }],
    ["the requester", { requesterRef: "req_other" }],
    ["the binding message", { bindingMessage: "Confirm your session" }],
    ["the target resource", { resourceRef: "res_other" }],
    ["the expiry window", { expiresAt: "2026-08-31T20:05:00.000Z" }],
    [
      "an extra hidden transaction",
      {
        authorizationDetails: [
          payment(),
          payment({ payee: { display_name: "Attacker" } }),
        ],
      },
    ],
    [
      "an added action",
      { authorizationDetails: [payment({ actions: ["write"] })] },
    ],
    [
      "a widened scope",
      { authorizationDetails: [payment({ privileges: ["admin"] })] },
    ],
  ];

  for (const [what, patch] of mutations) {
    it(`changes when ${what} changes`, () => {
      expect(canonicalRequestDigest(request(patch))).not.toBe(
        canonicalRequestDigest(request()),
      );
    });
  }

  it("reorders detail entries into a different digest", () => {
    // Order is preserved rather than sorted, so reordering is visible. A
    // canonicalizer that sorted here would let a request be reordered and
    // mutated together with only the mutation showing.
    const second = payment({ payee: { display_name: "Vendor B" } });
    const forward = canonicalRequestDigest(
      request({ authorizationDetails: [payment(), second] }),
    );
    const backward = canonicalRequestDigest(
      request({ authorizationDetails: [second, payment()] }),
    );
    expect(forward).not.toBe(backward);
  });

  it("cannot be forged by moving text across a field boundary", () => {
    const a = canonicalRequestDigest(
      request({ approverRef: "inbox_a", requesterRef: "bc" }),
    );
    const b = canonicalRequestDigest(
      request({ approverRef: "inbox_ab", requesterRef: "c" }),
    );
    expect(a).not.toBe(b);
  });

  it("matches only an identical digest", () => {
    const digest = canonicalRequestDigest(request());
    expect(digestMatches(digest, digest)).toBe(true);
    expect(digestMatches(digest, `${digest}x`)).toBe(false);
    expect(digestMatches(digest, digest.replace(/.$/, "0"))).toBe(false);
  });
});

describe("payment credentials never enter the authorization model", () => {
  const carriers: ReadonlyArray<[string, JsonObject]> = [
    ["a PAN under its own name", { pan: "4111111111111111" }],
    ["a card number", { card_number: "4111111111111111" }],
    ["a camelCase card number", { cardNumber: "4111111111111111" }],
    ["a hyphenated card number", { "card-number": "x" }],
    ["a CVV", { cvv: "123" }],
    ["a CVC", { cvc2: "123" }],
    ["a card security code", { cardSecurityCode: "123" }],
    ["an expiry", { expiryDate: "12/29" }],
    ["an exp month", { exp_month: "12" }],
    ["track data", { track2data: "x" }],
    ["a network token", { networkToken: "x" }],
    ["a cryptogram", { cryptogram: "x" }],
    ["a DPAN", { dpan: "x" }],
  ];

  for (const [what, extra] of carriers) {
    it(`refuses ${what}`, () => {
      expect(() => assertAuthorizationDetails([payment(extra)])).toThrow(
        /payment credential refused/,
      );
    });
  }

  it("refuses a PAN hidden under an innocuous field name", () => {
    expect(() =>
      assertAuthorizationDetails([
        payment({
          payee: { display_name: "V", reference: "4111 1111 1111 1111" },
        }),
      ]),
    ).toThrow(/primary account number/);
  });

  it("refuses a PAN nested deep inside an extension member", () => {
    expect(() =>
      assertNoPaymentCredentials({
        meta: { notes: [{ memo: "4111111111111111" }] },
      }),
    ).toThrow(/primary account number/);
  });

  it("names the path but never echoes the value", () => {
    try {
      assertNoPaymentCredentials({ memo: "4111111111111111" });
      expect.unreachable("should have refused");
    } catch (error) {
      expect(String(error)).toContain("$.memo");
      expect(String(error)).not.toContain("4111111111111111");
    }
  });

  it("catches a real PAN from every major network", () => {
    for (const pan of [
      "4111111111111111", // Visa
      "5555555555554444", // Mastercard
      "2223003122003222", // Mastercard 2-series
      "378282246310005", // Amex
      "6011111111111117", // Discover
      "3530111333300000", // JCB
      "30569309025904", // Diners
      "6221260000000000", // UnionPay
      "4111 1111 1111 1111", // as a human would paste it
      "4111-1111-1111-1111",
    ]) {
      expect(() => assertNoPaymentCredentials({ memo: pan })).toThrow(
        /primary account number/,
      );
    }
  });

  it("refuses hostile nesting instead of overflowing the stack", () => {
    // This runs on the create path over a body an authenticated caller
    // controls, and the schema's `.passthrough()` puts no bound on how deeply
    // an extension member nests. Recursion turned 256 KiB of nesting into a
    // RangeError, which the route surfaced as a 500 rather than the refusal it
    // should be.
    let deep: JsonValue = "leaf";
    for (let i = 0; i < 60_000; i += 1) deep = { n: deep };
    let caught: unknown;
    try {
      assertNoPaymentCredentials(deep);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    /*
     * SAFETY: the assertion above established that `caught` is a DomainError,
     * which extends Error, so reading `name` and `message` adds no assumption.
     */
    const refusal: Error = overlapCast(caught);
    expect(refusal.name).toBe("PaymentCredentialRefused");
    expect(refusal.message).toMatch(/nests deeper than/);
  });

  it("refuses a cycle rather than looping forever", () => {
    // JSON.parse cannot build one, but this function is exported and a JS
    // caller can hand over anything.
    const cyclic: MutableBoundaryObject = { type: "x" };
    cyclic.self = cyclic;
    expect(() => assertNoPaymentCredentials(overlapCast(cyclic))).toThrow(
      /contains a cycle/,
    );
  });

  it("still finds a PAN buried at a legitimate depth", () => {
    // The depth bound must not become a way to smuggle one past the guard.
    let nested: JsonValue = { memo: "4111111111111111" };
    for (let i = 0; i < 20; i += 1) nested = { inner: nested };
    expect(() => assertNoPaymentCredentials(nested)).toThrow(
      /primary account number/,
    );
  });

  it("keeps the refusal path bounded however wide the object", () => {
    const wide: MutableBoundaryObject = {};
    wide["k".repeat(4000)] = { memo: "4111111111111111" };
    try {
      assertNoPaymentCredentials(overlapCast(wide));
      expect.unreachable("should have refused");
    } catch (error) {
      /*
       * SAFETY: the call above is established to throw a PaymentCredentialRefused,
       * which extends Error; `expect.unreachable` covers the case where it does not.
       */
      const refusal: Error = overlapCast(error);
      expect(refusal.message.length).toBeLessThan(600);
    }
  });

  it("does not refuse a long number that is merely long", () => {
    // Luhn alone is not a PAN test: about one in ten arbitrary digit strings
    // passes it. A guard that refuses invoice numbers and order ids at that
    // rate gets switched off, and a guard that is off protects nothing — so
    // an issuer prefix is required too. Both of these pass Luhn.
    for (const notACard of [
      "4111111111111112", // Visa prefix, fails Luhn
      "8123456789012340", // passes Luhn, no issuer prefix
      "7123456789012342", // passes Luhn, no issuer prefix
      "3388000000022195321", // 19 digits, the shape of a wallet issuer id
    ]) {
      expect(() =>
        assertNoPaymentCredentials({ orderId: notACard }),
      ).not.toThrow();
    }
  });
});

describe("payment_initiation validation", () => {
  it("accepts a well-formed instruction", () => {
    expect(() => assertPaymentInitiation(payment())).not.toThrow();
  });

  it("refuses a numeric amount, which cannot round-trip a decimal", () => {
    expect(() =>
      assertPaymentInitiation(
        payment({ amount: { currency: "USD", value: 143.72 } }),
      ),
    ).toThrow(DomainError);
  });

  const badAmounts = ["", "-1", "1.234567", "1e3", "０.５", "143,72", "abc"];
  for (const value of badAmounts) {
    it(`refuses the amount ${JSON.stringify(value)}`, () => {
      expect(() =>
        assertPaymentInitiation(
          payment({ amount: { currency: "USD", value } }),
        ),
      ).toThrow(DomainError);
    });
  }

  it("refuses a non-ISO currency", () => {
    for (const currency of ["usd", "US", "USDT", ""]) {
      expect(() =>
        assertPaymentInitiation(
          payment({ amount: { currency, value: "1.00" } }),
        ),
      ).toThrow(DomainError);
    }
  });

  it("requires a payee with a display name", () => {
    expect(() => assertPaymentInitiation(payment({ payee: {} }))).toThrow(
      DomainError,
    );
    expect(() =>
      assertPaymentInitiation(payment({ payee: { display_name: "" } })),
    ).toThrow(DomainError);
  });

  it("refuses an empty details array and a detail with no type", () => {
    expect(() => assertAuthorizationDetails([])).toThrow(DomainError);
    expect(() =>
      /*
       * SAFETY: the empty `type` is the point. This checks that the validator
       * refuses a detail the domain type says cannot exist, which is exactly
       * what arrives from a caller that never saw the contract.
       */
      assertAuthorizationDetails([{ type: "" } as AuthorizationDetail]),
    ).toThrow(DomainError);
  });
});

describe("binding messages are derived, not supplied", () => {
  it("states the amount and payee for a payment", () => {
    expect(deriveBindingMessage([payment()])).toBe(
      "Pay 143.72 USD to Example Vendor",
    );
  });

  it("bounds a message however long the requester's strings are", () => {
    // The payee name is interpolated into a sentence that is then stored,
    // hashed and echoed, so an unbounded name was an unbounded row.
    const long = deriveBindingMessage([
      payment({ payee: { display_name: "V".repeat(400) } }),
    ]);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);

    const longTarget = deriveBindingMessage([
      {
        type: "connection_invoke",
        actions: ["read"],
        identifier: "x".repeat(9000),
      },
    ]);
    expect(longTarget.length).toBeLessThanOrEqual(120);
  });

  it("refuses a payee name too long to read off a screen", () => {
    expect(() =>
      assertPaymentInitiation(
        payment({ payee: { display_name: "V".repeat(400) } }),
      ),
    ).toThrow(/display_name exceeds/);
  });

  it("counts the operations a multi-detail request hides", () => {
    expect(deriveBindingMessage([payment(), payment()])).toContain("(+1 more)");
  });

  it("states the action and target for a non-payment operation", () => {
    expect(
      deriveBindingMessage([
        { type: "connection_invoke", actions: ["read"], identifier: "conn_1" },
      ]),
    ).toBe("read on conn_1");
  });

  it("falls back to the type when no action is named", () => {
    expect(deriveBindingMessage([{ type: "claim_resource" }])).toBe(
      "claim_resource",
    );
  });
});
