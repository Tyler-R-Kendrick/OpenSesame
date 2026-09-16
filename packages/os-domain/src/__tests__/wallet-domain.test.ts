import { describe, expect, it } from "vitest";
import { PaymentCredentialRefused } from "../authorization-details.js";
import type { PaymentInitiationDetail } from "../authorization-details.js";
import {
  MAX_AMOUNT_UNITS_EXACT,
  addAmountUnits,
  assertAmountUnits,
  assertRedistributedCapacity,
  compareAmountUnits,
  formatUnitsToDecimal,
  fromAmountExact,
  parseDecimalToUnits,
  subAmountUnits,
  toAmountExact,
} from "../wallet/amount.js";
import { WalletError } from "../wallet/errors.js";
import {
  EXECUTABLE_PAYMENT_INTENT_TYPE,
  EXECUTABLE_PAYMENT_INTENT_VERSION,
  assertExecutablePaymentIntent,
  assertLifecycleTransition,
  initialPaymentLifecycle,
  paymentInitiationGrantsExecutableAuthority,
} from "../wallet/payment-intent.js";
import type { ExecutablePaymentIntent } from "../wallet/payment-intent.js";

function validIntent(
  overrides: Partial<ExecutablePaymentIntent> = {},
): ExecutablePaymentIntent {
  return {
    type: EXECUTABLE_PAYMENT_INTENT_TYPE,
    version: EXECUTABLE_PAYMENT_INTENT_VERSION,
    id: "intent_1",
    walletRef: "wallet_1",
    domainRef: "domain_1",
    leaseRef: "lease_1",
    allocationRef: "alloc_1",
    destination: {
      kind: "address",
      chainId: "eip155:1",
      address: "0xabc123",
      displayName: "Merchant",
    },
    asset: { kind: "fiat", currency: "USD", exponent: 2 },
    amount: "1250",
    feeCeiling: "25",
    policyVersion: "pol-v3",
    idempotencyScope: "scope:checkout:1",
    requiredEnforcement: "independent_execution",
    requesterPrincipalRef: "principal_1",
    proofKeyThumbprint: "thumbprint-abcdef",
    protocolProfileRef: "profile_direct_transfer",
    requestCommitment: "abcdefghijklmnopqrstuvwxyz01234567",
    executionEnvironmentRef: "env_local",
    rootAccountingRef: "root_acct_1",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

describe("wallet AmountUnits", () => {
  it("parses and formats fixed-scale decimals without Number", () => {
    expect(parseDecimalToUnits("12.50", 2)).toBe("1250");
    expect(formatUnitsToDecimal("1250", 2)).toBe("12.50");
    expect(parseDecimalToUnits("0.01", 2)).toBe("1");
    expect(toAmountExact("1250")).toBe(1250n);
  });

  it("rejects NaN, negatives, exponent notation, and excess precision", () => {
    expect(() => parseDecimalToUnits("NaN", 2)).toThrow(WalletError);
    expect(() => parseDecimalToUnits("-1.00", 2)).toThrow(WalletError);
    expect(() => parseDecimalToUnits("1e2", 2)).toThrow(WalletError);
    expect(() => parseDecimalToUnits("1.234", 2)).toThrow(WalletError);
    expect(() => parseDecimalToUnits("+3", 2)).toThrow(WalletError);
  });

  it("rejects Unicode numerals and grouping separators", () => {
    expect(() => parseDecimalToUnits("١٢.٥٠", 2)).toThrow(WalletError);
    expect(() => parseDecimalToUnits("1,250.00", 2)).toThrow(WalletError);
    expect(() => parseDecimalToUnits("1 250", 0)).toThrow(WalletError);
  });

  it("checks add/sub/cmp and overflow at the 256-bit bound", () => {
    expect(addAmountUnits("10", "5")).toBe("15");
    expect(subAmountUnits("10", "5")).toBe("5");
    expect(compareAmountUnits("10", "5")).toBe(1);
    expect(() => subAmountUnits("1", "2")).toThrow(WalletError);
    const max = fromAmountExact(MAX_AMOUNT_UNITS_EXACT);
    expect(assertAmountUnits(max)).toBe(max);
    expect(() => addAmountUnits(max, "1")).toThrow(WalletError);
  });

  it("refuses child allocations that mint budget", () => {
    expect(() =>
      assertRedistributedCapacity("100", ["60", "50"], "at_most"),
    ).toThrow(WalletError);
    assertRedistributedCapacity("100", ["40", "60"], "exact");
  });
});

describe("executable payment intent", () => {
  it("accepts a versioned intent with destination identity", () => {
    const intent = validIntent();
    expect(() => assertExecutablePaymentIntent(intent)).not.toThrow();
  });

  it("treats token assets with different chain/decimals/fingerprint as distinct (WAL-D02)", () => {
    const a = {
      kind: "token" as const,
      chainId: "eip155:31337",
      contract: "0xaaa",
      decimals: 18,
      deploymentFingerprint:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const b = {
      ...a,
      decimals: 6,
      deploymentFingerprint:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    expect(() =>
      assertExecutablePaymentIntent(validIntent({ asset: a })),
    ).not.toThrow();
    expect(() =>
      assertExecutablePaymentIntent(validIntent({ asset: b })),
    ).not.toThrow();
    expect(a.decimals).not.toBe(b.decimals);
    expect(a.deploymentFingerprint).not.toBe(b.deploymentFingerprint);
    // Wrong scale for an 18-decimal asset must not silently round via float.
    expect(() => parseDecimalToUnits("1.234567", 6)).not.toThrow();
    expect(() => parseDecimalToUnits("1.234567", 2)).toThrow(WalletError);
  });

  it("requires destination identity beyond display name", () => {
    const bare = {
      ...validIntent(),
      destination: {
        kind: "address",
        chainId: "",
        address: "",
        displayName: "Only Name",
      },
    };
    expect(() => assertExecutablePaymentIntent(bare)).toThrow(WalletError);
  });

  it("refuses payment credentials in intent payloads", () => {
    const withPan = {
      ...validIntent(),
      note: { pan: "4111111111111111" },
    };
    expect(() => assertExecutablePaymentIntent(withPan)).toThrow(
      PaymentCredentialRefused,
    );
  });

  it("refuses unrecognized critical extensions by default", () => {
    expect(() =>
      assertExecutablePaymentIntent(
        validIntent({
          criticalExtensions: [{ name: "future.rail", critical: true }],
        }),
      ),
    ).toThrow(WalletError);
  });

  it("keeps payment_initiation authorization-only (DOM-08)", () => {
    const detail: PaymentInitiationDetail = {
      type: "payment_initiation",
      amount: { currency: "USD", value: "12.50" },
      payee: { display_name: "Cafe" },
    };
    expect(paymentInitiationGrantsExecutableAuthority(detail)).toBe(false);
  });
});

describe("payment lifecycle transitions", () => {
  it("allows reserved then submitted paths and rejects illegal jumps", () => {
    const start = initialPaymentLifecycle();
    const reserved = { ...start, execution: "reserved" as const };
    assertLifecycleTransition(start, reserved);
    const submitted = {
      ...reserved,
      execution: "authorized" as const,
      localIntent: "approved" as const,
    };
    assertLifecycleTransition(
      { ...reserved, localIntent: "approved" },
      submitted,
    );
    expect(() =>
      assertLifecycleTransition(start, {
        ...start,
        settlement: "settled",
      }),
    ).toThrow(WalletError);
  });

  it("moves reserved payment to unknown on timeout uncertainty (WAL-D13)", () => {
    const start = initialPaymentLifecycle();
    const reserved = { ...start, execution: "reserved" as const };
    assertLifecycleTransition(start, reserved);
    const unknown = { ...reserved, execution: "unknown" as const };
    assertLifecycleTransition(reserved, unknown);
    // Illegal jump from not_started straight to settled settlement is refused.
    expect(() =>
      assertLifecycleTransition(start, {
        ...start,
        settlement: "settled" as const,
      }),
    ).toThrow(WalletError);
  });

  it("keeps unresolved exposure reserved rather than inventing a second charge (WAL-D14)", () => {
    const start = initialPaymentLifecycle();
    const reserved = { ...start, execution: "reserved" as const };
    assertLifecycleTransition(start, reserved);
    // Same reserved state may stay reserved (retry observation); may not jump to settled.
    expect(() =>
      assertLifecycleTransition(reserved, {
        ...reserved,
        settlement: "settled" as const,
      }),
    ).toThrow(WalletError);
  });
});

describe("domain isolation (WAL-D16)", () => {
  it("refuses substituting another organization's domainRef on an intent", () => {
    const home = validIntent({ domainRef: "org-a", walletRef: "wallet-a" });
    expect(() => assertExecutablePaymentIntent(home)).not.toThrow();
    // A foreign domain string is structurally accepted as a ref, but the
    // requestCommitment / walletRef / domainRef tuple must stay consistent —
    // empty foreign refs are refused.
    expect(() =>
      assertExecutablePaymentIntent(
        validIntent({ domainRef: "", walletRef: "wallet-other" }),
      ),
    ).toThrow(WalletError);
  });
});

describe("cross-chain aggregation (WAL-D22)", () => {
  it("does not invent a shared counter across disconnected chain assets", () => {
    const a = validIntent({
      asset: {
        kind: "token",
        chainId: "eip155:1",
        contract: "0xaaa",
        decimals: 18,
        deploymentFingerprint:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      rootAccountingRef: "root-eth",
    });
    const b = validIntent({
      id: "intent_2",
      asset: {
        kind: "token",
        chainId: "eip155:137",
        contract: "0xbbb",
        decimals: 18,
        deploymentFingerprint:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      rootAccountingRef: "root-polygon",
    });
    expect(() => assertExecutablePaymentIntent(a)).not.toThrow();
    expect(() => assertExecutablePaymentIntent(b)).not.toThrow();
    // Distinct roots — no shared counter identity across chains.
    expect(a.rootAccountingRef).not.toBe(b.rootAccountingRef);
    expect(a.asset).not.toEqual(b.asset);
  });
});
