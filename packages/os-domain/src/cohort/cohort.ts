import {
  type CohortMember,
  compareCohortMembers,
  isLeafMember,
  nestedCohortOf,
  sameCohortMember,
} from "./member.js";
import { refuseCohort } from "./refusals.js";

/**
 * How deep a chain of nested cohorts may run, counting the root.
 *
 * Four is a shape somebody can still explain. The bound is on the longest chain
 * in the graph rather than on the route resolution happens to take.
 */
export const MAX_COHORT_DEPTH = 4;

/** How many members one cohort may name directly. */
export const MAX_COHORT_MEMBERS = 128;

/** How many cohorts one resolution may visit. */
export const MAX_COHORT_NODES = 64;

/** How many principals one cohort may make eligible. */
export const MAX_ELIGIBLE_PRINCIPALS = 2048;

/** How much of an operator-supplied cohort label is kept. */
export const MAX_COHORT_LABEL_CHARS = 120;

/**
 * When a cohort's membership is read: once and frozen, or at every use.
 *
 * The two are not interchangeable. A cohort declares its discipline once and
 * every activation is held to it. Serialized names are persisted — do not rename.
 */
export const ADMISSION_MODE_WIRE = ["live", "snapshot"] as const;

export type AdmissionMode = (typeof ADMISSION_MODE_WIRE)[number];

/**
 * A group, as stored.
 *
 * A cohort defines eligibility. An activation binds an individual. Being in a
 * cohort is never itself permission to do anything.
 */
export interface Cohort {
  readonly id: string;
  /** The boundary this cohort lives in. Membership never crosses it. */
  readonly organizationId: string;
  /**
   * Operator-supplied, shown to humans. Untrusted text: whatever renders it
   * escapes it.
   */
  readonly label: string;
  /**
   * Ordered and deduplicated, so the same membership always serializes the
   * same way and therefore digests the same way.
   */
  readonly members: readonly CohortMember[];
  readonly admission: AdmissionMode;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything a new cohort needs, named. */
export interface NewCohort {
  readonly id: string;
  readonly organizationId: string;
  readonly label: string;
  readonly members: readonly CohortMember[];
  readonly admission: AdmissionMode;
  readonly createdAt: Date;
}

/**
 * Create a cohort, refusing every shape that cannot be resolved.
 *
 * Mirrors `Cohort::new` in `crates/domain/src/cohort.rs`.
 */
export function makeCohort(spec: NewCohort): Cohort {
  const label = validateLabel(spec.label);
  const members = normalizeMembers(spec.members, spec.id);
  return {
    id: spec.id,
    organizationId: spec.organizationId,
    label,
    members,
    admission: spec.admission,
    createdAt: spec.createdAt,
    updatedAt: spec.createdAt,
  };
}

/**
 * Replace the membership, holding the same bounds as creation.
 *
 * Editing goes through here rather than through a public push so a cohort
 * cannot be grown past `MAX_COHORT_MEMBERS` one member at a time.
 */
export function withMembers(
  cohort: Cohort,
  members: readonly CohortMember[],
  updatedAt: Date,
): Cohort {
  return {
    ...cohort,
    members: normalizeMembers(members, cohort.id),
    updatedAt,
  };
}

/** The nested cohorts this one names, in a stable order. */
export function nestedCohortIds(cohort: Cohort): readonly string[] {
  const ids: string[] = [];
  for (const member of cohort.members) {
    const nested = nestedCohortOf(member);
    if (nested !== undefined) ids.push(nested);
  }
  return ids;
}

/**
 * The edges that admit principals without descending — direct principals and
 * teams, in a stable order.
 */
export function leafMembers(cohort: Cohort): readonly CohortMember[] {
  return cohort.members.filter(isLeafMember);
}

/**
 * Deduplicate, sort, and refuse empty / oversized / self-referential sets.
 */
function normalizeMembers(
  members: readonly CohortMember[],
  cohortId: string,
): readonly CohortMember[] {
  if (members.length === 0) {
    throw refuseCohort("empty", "cohort names no members");
  }
  const unique: CohortMember[] = [];
  for (const member of members) {
    if (!unique.some((existing) => sameCohortMember(existing, member))) {
      unique.push(member);
    }
  }
  if (unique.length > MAX_COHORT_MEMBERS) {
    throw refuseCohort(
      "too_many_members",
      `cohort names too many members: ${unique.length}`,
      {
        members: String(unique.length),
        maximum: String(MAX_COHORT_MEMBERS),
      },
    );
  }
  const selfEdge = unique.find(
    (member) => member.kind === "cohort" && member.cohortId === cohortId,
  );
  if (selfEdge !== undefined) {
    throw refuseCohort(
      "cycle",
      `cohort nesting cycle: ${cohortId} names itself as a member`,
      { cohortId, detail: `${cohortId} names itself as a member` },
    );
  }
  return [...unique].sort(compareCohortMembers);
}

/**
 * Trim, then refuse what a human cannot read or a log cannot hold safely.
 *
 * Control characters are refused rather than stripped: a label containing a
 * newline is somebody trying to forge a second line in whatever renders the
 * roster, and quietly repairing it would hide the attempt.
 */
function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    throw refuseCohort("label_invalid", "cohort label invalid: empty", {
      detail: "empty",
    });
  }
  const length = [...trimmed].length;
  if (length > MAX_COHORT_LABEL_CHARS) {
    throw refuseCohort(
      "label_invalid",
      `cohort label invalid: ${length} characters is longer than the ${MAX_COHORT_LABEL_CHARS} character maximum`,
      {
        length: String(length),
        maximum: String(MAX_COHORT_LABEL_CHARS),
        detail: `${length} characters is longer than the ${MAX_COHORT_LABEL_CHARS} character maximum`,
      },
    );
  }
  for (const char of trimmed) {
    if (isControlChar(char)) {
      throw refuseCohort(
        "label_invalid",
        "cohort label invalid: contains a control character",
        { detail: "contains a control character" },
      );
    }
  }
  return trimmed;
}

function isControlChar(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}
