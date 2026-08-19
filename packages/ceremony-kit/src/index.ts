/**
 * Ceremony logic shared by every surface that runs one: the standalone
 * ceremonies app (ADR 0045), the Pages vault app dogfooding the same flows,
 * and the console.
 *
 * Pure logic only — no React, no storage of its own, no ambient `fetch`. Each
 * surface passes in the pieces that differ: the ceremonies app resolves its
 * Identity API at build time, Pages resolves it at runtime from user settings,
 * and the two disagree about which storage a bearer may touch. Following the
 * `@opensesame/qr` convention, the logic is shared here and each app keeps its
 * own JSX.
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
