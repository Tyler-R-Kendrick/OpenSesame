import { DEFAULT_TIMING } from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { CirclePolicy } from "@opensesame/app-core/lib/quorum/types.js";
import { describe, expect, it } from "vitest";
import {
  APPROVALS_ONLY,
  DEFAULT_CLOCKS,
  type Person,
  WHOLE_VAULT,
  clocksOf,
  collectionOf,
  custodyDomainOf,
  defaultNeeded,
  defaultRule,
  issueOn,
  parseClocks,
  protectsOf,
  reconcileRule,
  review,
  ruleFromPolicy,
  ruleInput,
  ruleSide,
  wholeNumber,
  withOneGroup,
  withSecondGroup,
} from "./circle-model.js";

const people = (n: number): Person[] =>
  Array.from({ length: n }, (_, i) => ({ id: `g${i}`, name: `Person ${i}` }));

describe("what a circle protects", () => {
  it("names the whole vault, a folder, or approvals only, and reads it back", () => {
    expect(collectionOf("everything", "")).toBe(WHOLE_VAULT);
    expect(collectionOf("folder", "Banking")).toBe("Banking");
    expect(collectionOf("approvals", "")).toBe(APPROVALS_ONLY);

    const folders = ["Banking", "Home/Keys"];
    expect(protectsOf(true, WHOLE_VAULT, folders)).toEqual({
      protects: "everything",
      folder: "",
    });
    expect(protectsOf(true, "banking", folders)).toEqual({
      protects: "folder",
      folder: "Banking",
    });
    // A folder that has gone is still a folder: the circle does not widen to the vault.
    expect(protectsOf(true, "Gone", folders)).toEqual({
      protects: "folder",
      folder: "Gone",
    });
    expect(protectsOf(false, APPROVALS_ONLY, folders).protects).toBe(
      "approvals",
    );
  });
});

describe("the default rule", () => {
  it("asks for everyone while there are fewer than three, and half rounded up after", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(defaultNeeded)).toEqual([
      1, 2, 2, 2, 3, 3, 4,
    ]);
    expect(defaultNeeded(0)).toBe(1);
  });

  it("is one group of everyone", () => {
    const parsed = ruleInput(defaultRule(people(3)), people(3));
    expect(parsed).toEqual({
      ok: true,
      rule: {
        groups: [{ id: "All", threshold: 2, guardianIds: ["g0", "g1", "g2"] }],
        groupThreshold: 1,
      },
    });
  });

  it("keeps what was typed for the same people and starts over for different ones", () => {
    const typed = { ...defaultRule(people(3)), needed: { A: "3", B: "1" } };
    expect(reconcileRule(typed, people(3))).toBe(typed);
    expect(reconcileRule(typed, people(4)).needed.A).toBe("2");
    expect(reconcileRule(null, people(2)).needed.A).toBe("2");
    const custom = reconcileRule(typed, people(4), () =>
      withOneGroup(typed, []),
    );
    expect(custom.needed.A).toBe("1");
  });
});

describe("two groups", () => {
  it("splits the people down the middle and needs both groups", () => {
    const two = withSecondGroup(defaultRule(people(5)), people(5));
    expect(two.second).toBe(true);
    expect(two.groupsNeeded).toBe(2);
    expect(two.sides).toEqual({ g0: "A", g1: "A", g2: "A", g3: "B", g4: "B" });
    const parsed = ruleInput(two, people(5));
    expect(parsed.ok && parsed.rule).toEqual({
      groups: [
        { id: "A", threshold: 2, guardianIds: ["g0", "g1", "g2"] },
        { id: "B", threshold: 2, guardianIds: ["g3", "g4"] },
      ],
      groupThreshold: 2,
    });
    expect(withOneGroup(two, people(5)).second).toBe(false);
  });

  it("asks for someone in each group", () => {
    const two = withSecondGroup(defaultRule(people(2)), people(2));
    const lopsided = {
      ...two,
      sides: { g0: "A", g1: "A" } as const,
    };
    const parsed = ruleInput(lopsided, people(2));
    expect(parsed).toMatchObject({
      ok: false,
      issues: [{ field: "members", message: "Put someone in each group." }],
    });
  });
});

describe("what is typed for how many it takes", () => {
  it("is a whole number from 1 to 16", () => {
    for (const bad of ["", " ", "x", "0", "17", "1.5", "-1", "2 of 3"]) {
      const rule = { ...defaultRule(people(3)), needed: { A: bad, B: "1" } };
      const parsed = ruleInput(rule, people(3));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.issues[0]?.field).toBe("needed");
    }
    const ok = { ...defaultRule(people(3)), needed: { A: " 3 ", B: "1" } };
    expect(ruleInput(ok, people(3)).ok).toBe(true);
    expect(wholeNumber("007")).toBe(7);
    expect(wholeNumber("1234567")).toBeNull();
  });
});

describe("a saved rule laid over the people now", () => {
  const policy = (over: Partial<CirclePolicy>): CirclePolicy => ({
    v: 1,
    circleId: "c1",
    epoch: 1,
    label: "Family",
    collection: "Everything",
    rpId: "vault.example.test",
    origins: ["https://vault.example.test"],
    ownerKey: "k",
    groupThreshold: 1,
    groups: [{ id: "All", threshold: 2, guardianIds: ["g0", "g1", "g2"] }],
    guardians: [],
    shareCommitments: {},
    operations: ["grant-access"],
    approvalWindowSec: 600,
    releaseDelaySec: 86400,
    requestLifetimeSec: 604800,
    requireUserVerification: true,
    createdAt: "2026-10-10T12:00:00.000Z",
    ...over,
  });

  it("keeps one group's number, within the people who are left", () => {
    expect(ruleFromPolicy(policy({}), people(3)).needed.A).toBe("2");
    expect(ruleFromPolicy(policy({}), people(1)).needed.A).toBe("1");
  });

  it("keeps two groups and their members, and puts a newcomer in the first", () => {
    const two = policy({
      groupThreshold: 2,
      groups: [
        { id: "A", threshold: 2, guardianIds: ["g0", "g1"] },
        { id: "B", threshold: 1, guardianIds: ["g2"] },
      ],
    });
    const rule = ruleFromPolicy(two, people(4));
    expect(rule.second).toBe(true);
    expect(rule.groupsNeeded).toBe(2);
    expect(rule.sides).toEqual({ g0: "A", g1: "A", g2: "B", g3: "A" });
    expect(rule.needed).toEqual({ A: "2", B: "1" });
    // Everyone in the second group leaves: it is one group again.
    expect(ruleFromPolicy(two, people(2)).second).toBe(false);
  });
});

describe("the clocks", () => {
  it("start as the desk's defaults, in the units they are asked in", () => {
    expect(DEFAULT_CLOCKS).toEqual({
      minutes: "10",
      hours: "24",
      days: "7",
      verify: true,
    });
    expect(parseClocks(DEFAULT_CLOCKS)).toEqual({
      ok: true,
      timing: DEFAULT_TIMING,
    });
    expect(
      clocksOf({ ...DEFAULT_TIMING, requireUserVerification: false }),
    ).toEqual({
      ...DEFAULT_CLOCKS,
      verify: false,
    });
  });

  it("are refused outside what a policy can hold, one field at a time", () => {
    const bad = { ...DEFAULT_CLOCKS, minutes: "0", hours: "2161", days: "121" };
    const parsed = parseClocks(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((i) => i.field)).toEqual([
      "minutes",
      "hours",
      "days",
    ]);
    expect(parsed.issues.map((i) => i.message)).toEqual([
      "Minutes is 1 to 10,080.",
      "Hours is 0 to 2,160.",
      "Days is 1 to 120.",
    ]);
    // No delay at all is allowed; the desk warns about it.
    expect(parseClocks({ ...DEFAULT_CLOCKS, hours: "0" }).ok).toBe(true);
    expect(parseClocks({ ...DEFAULT_CLOCKS, days: "" }).ok).toBe(false);
  });
});

describe("what the desk said about a draft", () => {
  it("puts a refusal on the field it is about", () => {
    const on = (code: string, message: string) =>
      review({ ok: false, code, message }).issues[0]?.field;
    expect(
      on("member_threshold", "group All needs more guardians than it has"),
    ).toBe("needed");
    expect(
      on("member_threshold", "group B needs more guardians than it has"),
    ).toBe("needed-b");
    expect(on("member_threshold_one", "a 1-of-N group adds no security")).toBe(
      "needed",
    );
    expect(on("group_threshold", "x")).toBe("groups");
    expect(on("guardian_in_two_groups", "x")).toBe("members");
    expect(on("lifetime", "the approval window outlasts the request")).toBe(
      "minutes",
    );
    expect(
      on(
        "lifetime",
        "the request would expire before any share could be released",
      ),
    ).toBe("days");
    expect(on("no_prf", "Ada has no key that can protect a share")).toBe(
      "step",
    );
    expect(on("anything_else", "x")).toBe("step");
  });

  it("words a refusal as a sentence and carries a verdict's warnings through", () => {
    const refused = review({
      ok: false,
      code: "member_threshold_one",
      message: "a 1-of-N group adds no security: use one guardian",
    });
    expect(refused.issues[0]?.message).toBe(
      "A 1-of-N group adds no security: use one guardian.",
    );
    const warned = review({
      ok: true,
      warnings: [{ code: "no_delay", message: "No delay." }],
    });
    expect(warned.issues).toEqual([]);
    expect(warned.warnings).toHaveLength(1);
  });

  it("answers the rule with its own refusals and leaves the clocks to their step", () => {
    const verdict = {
      issues: [
        { field: "needed" as const, message: "a" },
        { field: "days" as const, message: "b" },
        { field: "step" as const, message: "c" },
      ],
      warnings: [],
    };
    expect(ruleSide(verdict).issues.map((i) => i.field)).toEqual([
      "needed",
      "step",
    ]);
    expect(issueOn("days", verdict.issues)).toBe("b");
    expect(issueOn("hours", verdict.issues)).toBeNull();
  });
});

describe("a contact's household", () => {
  const fresh = () => "abc123";
  it("is its own unless the owner names one", () => {
    expect(custodyDomainOf("", fresh)).toBe("solo-abc123");
    expect(custodyDomainOf("   ", fresh)).toBe("solo-abc123");
    expect(custodyDomainOf("!!!", fresh)).toBe("solo-abc123");
  });

  it("is one id for the same words however they are spaced, and a valid id", () => {
    expect(custodyDomainOf("The Smith  family", fresh)).toBe(
      "home-the-smith-family",
    );
    expect(custodyDomainOf("the smith family", fresh)).toBe(
      custodyDomainOf("The Smith Family", fresh),
    );
    const long = custodyDomainOf("x".repeat(200), fresh);
    expect(long).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
    expect(long.length).toBeLessThanOrEqual(64);
  });
});
