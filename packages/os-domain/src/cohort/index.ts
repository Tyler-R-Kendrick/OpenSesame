/**
 * Cohorts: groups that decide **who may ask**, never groups that hold
 * authority of their own.
 *
 * Client-plane mirror of `crates/domain/src/cohort.rs`. A cohort is a named,
 * possibly nested group — the on-call rotation, the security reviewers,
 * everyone in the incident channel. It composes principals directly, existing
 * teams, and other cohorts.
 *
 * **A group defines eligibility. An activation binds an individual.** Being in
 * a cohort is never itself permission to do anything.
 */
export * from "./refusals.js";
export * from "./member.js";
export * from "./cohort.js";
