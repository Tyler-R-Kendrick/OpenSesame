/**
 * Application-code trigger enrollment and selection (TRIGGER-A, TRIGGER-B).
 * Complete submission only; never prefix-match; at most one slot match.
 * Owner consent + isolated rehearsal required before atomic commit.
 */

export type {
  EnrolledTrigger,
  EnrollmentCapabilities,
  EnrollmentDraft,
  EnrollmentState,
} from "./enrollment-state.js";
export { createEmptyEnrollmentState } from "./enrollment-state.js";

export {
  beginEnrollmentDraft,
  commitEnrollmentDraft,
  enrollTrigger,
  runIsolatedRehearsal,
  stageTriggerInDraft,
} from "./enrollment-draft.js";

export type {
  SelectTriggerOptions,
  TriggerMatch,
} from "./enrollment-select.js";
export { disposeTriggerMatch, selectTrigger } from "./enrollment-select.js";
