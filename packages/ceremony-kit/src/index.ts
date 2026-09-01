/**
 * Ceremony logic shared by every surface that runs one: the standalone
 * ceremonies app (ADR 0045), the Pages vault app dogfooding the same flows,
 * the console, mobile MFA, and the CLIs.
 *
 * Pure logic only — no React, no storage of its own, no ambient `fetch`. Each
 * surface passes in the pieces that differ: the ceremonies app resolves its
 * Identity API at build time, Pages resolves it at runtime from user settings,
 * and the two disagree about which storage a bearer may touch. Following the
 * `@opensesame/qr` convention, the logic is shared here and each app keeps its
 * own JSX.
 *
 * Cross-device interaction links (ADR 0086) are built, parsed, driven and
 * rendered here and nowhere else. Four apps used to hold four private copies
 * of that knowledge, which meant four link formats, four expiry stories, and
 * four independent chances to put a bearer in a URL.
 */

export {
  parseUserCode,
  readFragmentToken,
  scrubFragment,
} from "./deep-link.js";
export {
  type ClaimStash,
  createClaimStash,
  type StashStorage,
} from "./claim-stash.js";
export {
  approveDevice,
  type ApproveDeviceInput,
  CeremonyRequestError,
} from "./device.js";
export {
  assertNoForbiddenParams,
  buildInteractionUrl,
  InteractionLinkError,
  type InteractionLinkErrorReason,
  isInteractionRef,
  type LegacyInteractionLink,
  parseInteractionUrl,
  parseLegacyInteractionLink,
} from "./interaction-url.js";
export {
  type ApproveInteractionInput,
  createInteractionClient,
  type DenyInteractionInput,
  type InteractionClient,
  type InteractionClientOptions,
  InteractionError,
  type InteractionErrorCode,
} from "./interaction-client.js";
export {
  renderInteractionSummary,
  type RenderedInteractionSummary,
} from "./interaction-summary.js";
