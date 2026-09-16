import { describe, expect, it } from "vitest";
import {
  ADMISSION_MODE_WIRE,
  type AdmissionMode,
  COHORT_MEMBER_KIND_WIRE,
  COHORT_REFUSALS,
  type CohortMember,
  MAX_COHORT_LABEL_CHARS,
  MAX_COHORT_MEMBERS,
  compareCohortMembers,
  isLeafMember,
  leafMembers,
  makeCohort,
  nestedCohortIds,
  nestedCohortMember,
  nestedCohortOf,
  principalMember,
  teamMember,
  withMembers,
} from "../cohort/index.js";
import { DomainError } from "../errors.js";

const NOW = new Date("2026-03-15T12:00:00Z");
const LATER = new Date("2026-03-15T13:00:00Z");

function reason(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return String(error.details.reason);
    throw error;
  }
  throw new Error("expected a refusal");
}

function cohortOf(
  members: readonly CohortMember[],
  admission: AdmissionMode = "live",
  label = "on-call",
) {
  return makeCohort({
    id: "coh_root",
    organizationId: "org_a",
    label,
    members,
    admission,
    createdAt: NOW,
  });
}

describe("cohort wire tags", () => {
  it("keeps the frozen membership and admission tags", () => {
    expect([...COHORT_MEMBER_KIND_WIRE]).toEqual([
      "principal",
      "team",
      "cohort",
    ]);
    expect([...ADMISSION_MODE_WIRE]).toEqual(["live", "snapshot"]);
    expect([...COHORT_REFUSALS]).toEqual([
      "label_invalid",
      "empty",
      "too_many_members",
      "cycle",
    ]);
  });
});

describe("cohort membership edges", () => {
  it("orders and deduplicates so the same roster digests the same way", () => {
    const cohort = cohortOf([
      nestedCohortMember("coh_b"),
      principalMember("prn_z"),
      teamMember("team_a"),
      principalMember("prn_a"),
      principalMember("prn_z"),
    ]);
    expect(cohort.members).toEqual([
      principalMember("prn_a"),
      principalMember("prn_z"),
      teamMember("team_a"),
      nestedCohortMember("coh_b"),
    ]);
    expect(nestedCohortIds(cohort)).toEqual(["coh_b"]);
    expect(leafMembers(cohort)).toEqual([
      principalMember("prn_a"),
      principalMember("prn_z"),
      teamMember("team_a"),
    ]);
    expect(isLeafMember(principalMember("prn_a"))).toBe(true);
    expect(nestedCohortOf(nestedCohortMember("coh_b"))).toBe("coh_b");
    expect(
      compareCohortMembers(principalMember("a"), teamMember("a")),
    ).toBeLessThan(0);
  });

  it("declares live vs snapshot binding as a field on the cohort", () => {
    expect(cohortOf([principalMember("prn_1")], "live").admission).toBe("live");
    expect(cohortOf([principalMember("prn_1")], "snapshot").admission).toBe(
      "snapshot",
    );
  });
});

describe("cohort construction refusals", () => {
  it("refuses an empty membership", () => {
    expect(reason(() => cohortOf([]))).toBe("empty");
  });

  it("refuses a self-referential nest", () => {
    expect(
      reason(() =>
        makeCohort({
          id: "coh_self",
          organizationId: "org_a",
          label: "loop",
          members: [nestedCohortMember("coh_self")],
          admission: "live",
          createdAt: NOW,
        }),
      ),
    ).toBe("cycle");
  });

  it("refuses empty, over-long, and control-bearing labels", () => {
    expect(
      reason(() => cohortOf([principalMember("prn_1")], "live", "  ")),
    ).toBe("label_invalid");
    expect(
      reason(() =>
        cohortOf(
          [principalMember("prn_1")],
          "live",
          "x".repeat(MAX_COHORT_LABEL_CHARS + 1),
        ),
      ),
    ).toBe("label_invalid");
    expect(
      reason(() => cohortOf([principalMember("prn_1")], "live", "bad\nlabel")),
    ).toBe("label_invalid");
  });

  it("refuses growing past the direct-member ceiling", () => {
    const members = Array.from({ length: MAX_COHORT_MEMBERS + 1 }, (_, i) =>
      principalMember(`prn_${i}`),
    );
    expect(reason(() => cohortOf(members))).toBe("too_many_members");
    const atCap = cohortOf(
      Array.from({ length: MAX_COHORT_MEMBERS }, (_, i) =>
        principalMember(`prn_${i}`),
      ),
    );
    expect(
      reason(() =>
        withMembers(
          atCap,
          [...atCap.members, principalMember("prn_extra")],
          LATER,
        ),
      ),
    ).toBe("too_many_members");
  });

  it("replaces membership through withMembers and bumps updatedAt", () => {
    const original = cohortOf([principalMember("prn_1"), teamMember("team_a")]);
    const next = withMembers(
      original,
      [principalMember("prn_2"), nestedCohortMember("coh_child")],
      LATER,
    );
    expect(next.members).toEqual([
      principalMember("prn_2"),
      nestedCohortMember("coh_child"),
    ]);
    expect(next.updatedAt).toEqual(LATER);
    expect(next.createdAt).toEqual(NOW);
    expect(reason(() => withMembers(original, [], LATER))).toBe("empty");
  });
});
