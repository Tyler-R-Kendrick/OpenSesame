import { DomainError } from "../errors.js";

/**
 * Every way a cohort operation can be refused.
 *
 * Names mirror the `DomainError::Cohort*` variants that `crates/domain/src/cohort.rs`
 * raises at construction and membership edit, so a refusal means the same thing
 * on both planes.
 */
export const COHORT_REFUSALS = [
  "label_invalid",
  "empty",
  "too_many_members",
  "cycle",
] as const;

export type CohortRefusal = (typeof COHORT_REFUSALS)[number];

/**
 * What a refusal may say about itself.
 *
 * Closed record: every field names an entity or a count. A refusal identifies
 * the cohort or label at fault and carries nothing that came out of a vault.
 */
export interface CohortRefusalDetails {
  readonly cohortId?: string;
  readonly length?: string;
  readonly maximum?: string;
  readonly members?: string;
  readonly detail?: string;
}

/**
 * Raise a cohort refusal.
 *
 * Codes stay on the shared `DomainErrorCode` union; `details.reason` is the
 * precise rule that broke.
 */
export function refuseCohort(
  reason: CohortRefusal,
  message: string,
  details: CohortRefusalDetails = {},
): DomainError {
  return new DomainError("INVARIANT_VIOLATION", message, {
    reason,
    ...details,
  });
}
