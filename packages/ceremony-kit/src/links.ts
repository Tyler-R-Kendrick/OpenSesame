/**
 * Synchronous link arrival and claim stash API for boot, before a ceremony
 * starts. These are the same readers and storage contracts as the main entry;
 * transport clients, approval models and authenticators stay with their users.
 */
export { type ApprovalArrival, readApprovalArrival } from "./approval-link.js";
export {
  LEGACY_LINKS,
  ceremonyPath,
  matchCeremonyPath,
} from "./ceremony-routes.js";
export {
  type ClaimLink,
  fragmentCarriesBearer,
  isClaimToken,
  readClaimLink,
} from "./claim-link.js";
export { type ClaimStash, createClaimStash } from "./claim-stash.js";
export {
  type InteractionArrival,
  readInteractionArrival,
} from "./interaction-arrival.js";
export { parseLegacyInteractionLink } from "./interaction-url.js";
export {
  type InvocationArrival,
  readInvocationArrival,
} from "./invocation-link.js";
