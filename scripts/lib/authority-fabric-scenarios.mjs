/**
 * Scenario registry for the general-authority fabric (work item TEST-SCENARIOS).
 *
 * Every scenario names a contract from
 * docs/implementation/general-authority/contract-registry.json and the exact
 * test that would settle it. A scenario is never satisfied by this file: it is
 * satisfied only when the named test exists in a module reachable from its crate
 * root and passes. A name that does not resolve is reported blocked, which fails
 * the gate.
 *
 * The scenarios themselves are grouped by what they reach into:
 * `-host` for single-module Rust contracts, `-cross` for everything wider,
 * `-cohort` for live-offer writer and issuance-preflight contracts.
 */

import { atRestPlaneScenarios } from "./authority-fabric-scenarios-at-rest.mjs";
import { atTailPlaneScenarios } from "./authority-fabric-scenarios-at-tail.mjs";
import { atPlaneScenarios } from "./authority-fabric-scenarios-at.mjs";
import { cohortPlaneScenarios } from "./authority-fabric-scenarios-cohort.mjs";
import { crossPlaneScenarios } from "./authority-fabric-scenarios-cross.mjs";
import { fixPlaneScenarios } from "./authority-fabric-scenarios-fix.mjs";
import { hostPlaneScenarios } from "./authority-fabric-scenarios-host.mjs";

/** What a scenario needs at run time. Not a severity, and not an ordering. */
export const TIERS = Object.freeze([
  "unit",
  "integration",
  "provider",
  "live",
  "unsupported",
]);

/**
 * `blocked` is the fail-closed verdict: the target is not wired, the code did not
 * build, or no test asserts the contract. `unsupported` is a declared limit of
 * the harness and is counted apart from both success and failure.
 */
export const STATUSES = Object.freeze([
  "pass",
  "fail",
  "blocked",
  "unsupported",
]);

/** @type {readonly object[]} */
export const scenarios = Object.freeze([
  ...hostPlaneScenarios,
  ...crossPlaneScenarios,
  ...fixPlaneScenarios,
  ...cohortPlaneScenarios,
  ...atPlaneScenarios,
  ...atRestPlaneScenarios,
  ...atTailPlaneScenarios,
]);
