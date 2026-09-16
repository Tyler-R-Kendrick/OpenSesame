import { describe, expect, it } from "vitest";
import {
  type ConstraintEnforcement,
  type ConstraintKind,
  type ConstraintSet,
  type PeriodSemantics,
  type PolicyConstraint,
  type ProviderEffective,
  assess,
  intersectAncestors,
} from "./index.js";

const contractAuthority = {
  kind: "contract",
  chainId: "31337",
  account: "0xaccount",
  manager: "0xmanager",
  sharedRootRef: "root_1",
  deploymentManifestRef: "manifest_1",
} as const;

type ProviderFixture = {
  readonly adjustmentAllowed?: boolean;
  readonly periodSemantics?: PeriodSemantics;
  readonly enforcedKinds?: readonly ConstraintKind[];
};

function amount(ceiling: string, critical = true): PolicyConstraint {
  return {
    kind: "amount",
    ref: "c_amount",
    ceiling,
    critical,
  };
}

function recipient(
  allowed: readonly string[],
  critical = true,
): PolicyConstraint {
  return {
    kind: "recipient",
    ref: "c_recipient",
    allowed,
    critical,
  };
}

function fee(maxFee: string, critical = true): PolicyConstraint {
  return {
    kind: "fee",
    ref: "c_fee",
    maxFee,
    critical,
  };
}

function redelegation(maxDepth: number, critical = true): PolicyConstraint {
  return {
    kind: "redelegation",
    ref: "c_redelegation",
    maxDepth,
    critical,
  };
}

function asset(): PolicyConstraint {
  return {
    kind: "asset",
    ref: "c_asset",
    critical: true,
    asset: {
      kind: "token",
      chainId: "31337",
      contract: "0xtoken",
      decimals: 6,
      deploymentFingerprint: "fp_token",
    },
  };
}

function calendarPeriod(): PolicyConstraint {
  return {
    kind: "period",
    ref: "c_period",
    critical: true,
    window: {
      kind: "calendar",
      unit: "day",
      timeZone: "UTC",
      boundaryScheduleRef: "sched_utc_day",
      validUntil: "2027-01-01T00:00:00Z",
      rollover: "none",
    },
  };
}

function fixedIntervalPeriod(durationSeconds: string): PolicyConstraint {
  return {
    kind: "period",
    ref: "c_period",
    critical: true,
    window: {
      kind: "fixed_interval",
      anchor: "2026-01-01T00:00:00Z",
      durationSeconds,
      validUntil: "2027-01-01T00:00:00Z",
      rollover: "none",
    },
  };
}

function set(
  constraints: readonly PolicyConstraint[],
  adjustmentAllowed?: boolean,
): ConstraintSet {
  if (adjustmentAllowed === undefined) {
    return { constraints };
  }
  return { constraints, adjustmentAllowed };
}

function provider(
  constraints: readonly PolicyConstraint[],
  fixture: ProviderFixture = {},
): ProviderEffective {
  const base = {
    constraints,
    capabilities: {
      periodSemantics: fixture.periodSemantics ?? "fixed_interval",
      enforcedKinds: fixture.enforcedKinds ?? [
        "amount",
        "recipient",
        "period",
        "fee",
        "redelegation",
        "asset",
      ],
      authority: contractAuthority,
    },
  } satisfies ProviderEffective;
  if (fixture.adjustmentAllowed === undefined) {
    return base;
  }
  return { ...base, adjustmentAllowed: fixture.adjustmentAllowed };
}

function rowFor(
  rows: readonly ConstraintEnforcement[],
  kind: ConstraintKind,
): ConstraintEnforcement | undefined {
  return rows.find((row) => row.kind === kind);
}

describe("assess — table-driven enforcement", () => {
  it.each([
    {
      name: "equal permissions enforce when capabilities cover every kind",
      requested: set([amount("100"), recipient(["0xmerchant"]), fee("5")]),
      approved: set([amount("100"), recipient(["0xmerchant"]), fee("5")]),
      providerEffective: provider([
        amount("100"),
        recipient(["0xmerchant"]),
        fee("5"),
      ]),
      kinds: ["amount", "recipient", "fee"] as const,
      result: "enforced" as const,
    },
    {
      name: "narrower effective amount remains enforced",
      requested: set([amount("50")]),
      approved: set([amount("100")]),
      providerEffective: provider([amount("50")]),
      kinds: ["amount"] as const,
      result: "enforced" as const,
    },
    {
      name: "no providerEffective yields approval_only",
      requested: set([amount("100")]),
      approved: set([amount("100")]),
      providerEffective: undefined,
      kinds: ["amount"] as const,
      result: "approval_only" as const,
    },
  ] as const)(
    "$name",
    ({ requested, approved, providerEffective, kinds, result }) => {
      const rows = assess(requested, approved, providerEffective);
      for (const kind of kinds) {
        expect(rowFor(rows, kind)?.result).toBe(result);
      }
    },
  );
});

describe("assess — widening refused even with adjustment flags", () => {
  const adjust: ProviderFixture = { adjustmentAllowed: true };

  it.each([
    {
      name: "provider returns higher amount ceiling",
      requested: set([amount("100")]),
      approved: set([amount("100")]),
      providerEffective: provider([amount("200")], adjust),
      kind: "amount" as const,
    },
    {
      name: "provider returns extra recipient",
      requested: set([recipient(["0xa"])]),
      approved: set([recipient(["0xa"])]),
      providerEffective: provider([recipient(["0xa", "0xb"])], adjust),
      kind: "recipient" as const,
    },
    {
      name: "provider returns higher fee cap",
      requested: set([fee("3")]),
      approved: set([fee("3")]),
      providerEffective: provider([fee("30")], adjust),
      kind: "fee" as const,
    },
    {
      name: "provider returns deeper redelegation",
      requested: set([redelegation(0)]),
      approved: set([redelegation(0)]),
      providerEffective: provider([redelegation(2)], adjust),
      kind: "redelegation" as const,
    },
    {
      name: "requested amount exceeds approved",
      requested: set([amount("200")]),
      approved: set([amount("100")]),
      providerEffective: provider([amount("100")]),
      kind: "amount" as const,
    },
    {
      name: "requested kind absent from approved",
      requested: set([amount("100"), fee("5")]),
      approved: set([amount("100")]),
      providerEffective: provider([amount("100")]),
      kind: "fee" as const,
    },
  ] as const)("$name", ({ requested, approved, providerEffective, kind }) => {
    const row = rowFor(assess(requested, approved, providerEffective), kind);
    expect(row?.result).toBe("unsupported");
    expect(row?.detailCode).toBe("POLICY_WIDENING_REFUSED");
  });
});

describe("assess — omitted inherited limits", () => {
  const adjust: ProviderFixture = { adjustmentAllowed: true };

  it.each([
    {
      name: "amount omitted",
      approved: set([amount("100"), recipient(["0xa"])]),
      providerEffective: provider([recipient(["0xa"])], adjust),
      missing: "amount" as const,
    },
    {
      name: "recipient omitted",
      approved: set([amount("100"), recipient(["0xa"])]),
      providerEffective: provider([amount("100")]),
      missing: "recipient" as const,
    },
    {
      name: "fee omitted",
      approved: set([amount("100"), fee("5")]),
      providerEffective: provider([amount("100")], adjust),
      missing: "fee" as const,
    },
    {
      name: "asset omitted",
      approved: set([amount("100"), asset()]),
      providerEffective: provider([amount("100")]),
      missing: "asset" as const,
    },
  ] as const)("$name", ({ approved, providerEffective, missing }) => {
    const row = rowFor(assess(approved, approved, providerEffective), missing);
    expect(row?.result).toBe("unsupported");
    expect(row?.detailCode).toBe("REQUIRED_CONSTRAINT_UNSUPPORTED");
  });
});

describe("assess — unknown critical constraints", () => {
  const noRedelegation: ProviderFixture = {
    enforcedKinds: ["amount", "recipient", "period", "fee", "asset"],
  };
  const amountOnly: ProviderFixture = { enforcedKinds: ["amount"] };
  const none: ProviderFixture = { enforcedKinds: [] };

  it.each([
    {
      name: "critical redelegation not in enforcedKinds",
      approved: set([amount("100"), redelegation(0, true)]),
      providerEffective: provider(
        [amount("100"), redelegation(0, true)],
        noRedelegation,
      ),
      kind: "redelegation" as const,
      detailCode: "UNKNOWN_CRITICAL_CONSTRAINT" as const,
      result: "unsupported" as const,
    },
    {
      name: "non-critical fee without enforcement stays approval_only",
      approved: set([amount("100"), fee("5", false)]),
      providerEffective: provider([amount("100"), fee("5", false)], amountOnly),
      kind: "fee" as const,
      detailCode: undefined,
      result: "approval_only" as const,
    },
    {
      name: "critical recipient without enforcement refuses",
      approved: set([recipient(["0xa"], true)]),
      providerEffective: provider([recipient(["0xa"], true)], none),
      kind: "recipient" as const,
      detailCode: "UNKNOWN_CRITICAL_CONSTRAINT" as const,
      result: "unsupported" as const,
    },
  ] as const)(
    "$name",
    ({ approved, providerEffective, kind, detailCode, result }) => {
      const row = rowFor(assess(approved, approved, providerEffective), kind);
      expect(row?.result).toBe(result);
      expect(row?.detailCode).toBe(detailCode);
    },
  );
});

describe("assess — period semantics", () => {
  const periodFixture: ProviderFixture = {
    periodSemantics: "fixed_interval",
    enforcedKinds: ["period"],
  };

  it("PERIOD_SEMANTICS_UNSUPPORTED when calendar approved but only fixed_interval", () => {
    const approved = set([calendarPeriod()]);
    const providerEffective = provider(
      [fixedIntervalPeriod("86400")],
      periodFixture,
    );
    const row = rowFor(assess(approved, approved, providerEffective), "period");
    expect(row?.result).toBe("unsupported");
    expect(row?.detailCode).toBe("PERIOD_SEMANTICS_UNSUPPORTED");
  });

  it("capabilities win even if effective echo is calendar-shaped", () => {
    const approved = set([calendarPeriod()]);
    const providerEffective = provider([calendarPeriod()], periodFixture);
    const row = rowFor(assess(approved, approved, providerEffective), "period");
    expect(row?.detailCode).toBe("PERIOD_SEMANTICS_UNSUPPORTED");
  });

  it("enforces matching fixed_interval when that is approved", () => {
    const approved = set([fixedIntervalPeriod("86400")]);
    const providerEffective = provider(
      [fixedIntervalPeriod("86400")],
      periodFixture,
    );
    const row = rowFor(assess(approved, approved, providerEffective), "period");
    expect(row?.result).toBe("enforced");
    expect(row?.detailCode).toBeUndefined();
  });
});

describe("intersectAncestors", () => {
  it("keeps inherited amount when a child omits it", () => {
    const merged = intersectAncestors([
      set([amount("100"), recipient(["0xa", "0xb"])]),
      set([recipient(["0xa"])]),
    ]);
    expect(merged.constraints.map((c) => c.kind).sort()).toEqual([
      "amount",
      "recipient",
    ]);
    const amt = merged.constraints.find((c) => c.kind === "amount");
    expect(amt?.kind === "amount" && amt.ceiling).toBe("100");
    const recv = merged.constraints.find((c) => c.kind === "recipient");
    expect(recv?.kind === "recipient" && [...recv.allowed]).toEqual(["0xa"]);
  });

  it("tightens to the lower ceiling across ancestors", () => {
    const merged = intersectAncestors([
      set([amount("500")]),
      set([amount("200")]),
      set([amount("150")]),
    ]);
    const only = merged.constraints[0];
    expect(only?.kind === "amount" && only.ceiling).toBe("150");
  });
});
