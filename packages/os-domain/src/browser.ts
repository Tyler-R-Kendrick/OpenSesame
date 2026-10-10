/**
 * Browser-safe surface. The Node HMAC/digest helpers stay on the main entry
 * (`index.ts`) so Pages/PWA/extension never pull `node:crypto`.
 */
export * from "./json.js";
export * from "./fnv1a.js";
export * from "./canonical-origin.js";
export * from "./types.js";
// Published vault address owner/slug (ADR 0181). A pure parser, no I/O.
export * from "./org-vault-ref.js";
export * from "./errors.js";
export * from "./endpoint-display.js";
export * from "./endpoints.js";
export * from "./invariants.js";
export * from "./machines/authorization-request.js";
export * as interactionMachine from "./machines/interaction.js";
export * from "./machines/claim.js";
export * from "./machines/device-auth.js";
export * from "./machines/provisional-resource.js";
export * from "./machines/agent-registration.js";
export * from "./interaction-links.js";
export * from "./interaction.js";
// The browser-local approval path seals its own proof (ADR 0086 §7); the
// constructor is pure, so only it and its types ride on this entry.
export {
  type SealedApprovalProof,
  type ServerEstablishedApproval,
  sealApprovalProof,
} from "./proofs/approval-seal.js";
export * from "./authorization-details.js";
export * from "./trust.js";
// Channel capability is one closed record (ADR 0084), and the browser reads
// it too: a settings screen and an approval review name channels with it.
export * from "./notifications.js";
// An Identity-account factor as its owner sees it (ADR 0140 D10).
export * from "./account-factors.js";
export {
  canonicalize,
  digestManifest,
  sha256Hex,
} from "./crypto/digest-browser.js";
export * from "./transport-security/index.js";
