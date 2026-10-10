import { ADR_TRUSTED_CONTACTS } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

/**
 * Trusted contacts (ADR 0187): a circle of people who, as a quorum, approve a
 * request or hold shares of a recovery key. Every operation is a ceremony a
 * person performs on their own device with their own security key, and each
 * one is withheld from every agent surface: a tool an agent could drive would
 * let it raise, approve or release a request on a person's behalf, which is the
 * one thing a quorum exists to prevent. The browser's side is the Settings >
 * Trusted contacts category; the terminal's exit door is `vault.circle.*`.
 */
const QUORUM_HUMAN: CapabilityExclusion = {
  reason:
    "a circle's owner key, a contact's wrapped share and every approval are held and given by people with their own security keys; a surface an agent could drive would let it raise, approve or release a request on their behalf, which is the one thing a quorum exists to prevent",
  adr: ADR_TRUSTED_CONTACTS,
};

const AGENTS_WITHHELD = {
  mcp_host: QUORUM_HUMAN,
  mcp_client: QUORUM_HUMAN,
  webmcp: QUORUM_HUMAN,
} as const;

export const trustedContactCapabilities: readonly Capability[] = [
  {
    id: "quorum.circle.manage",
    title:
      "Start, change, cancel a request for and retire a circle of trusted contacts",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/quorum/desk/owner.ts:createFromDraft",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "quorum.share.ask",
    title: "Ask a circle to approve sharing something with a person",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/quorum/desk/owner-act.ts:askToShare",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "quorum.guardian.hold",
    title: "Accept an invitation and hold a share for someone else",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/quorum/desk/guardian.ts:takeWelcome",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "quorum.request.approve",
    title: "Approve a request, or release a share to it, with a security key",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/quorum/desk/guardian-act.ts:approveRequest",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
  {
    id: "quorum.recover",
    title: "Gather approvals and releases and open what a circle protects",
    plane: "client_local",
    kind: "ceremony",
    surfaces: {
      cli: null,
      pwa: "lib/quorum/desk/recipient.ts:openRecovery",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: AGENTS_WITHHELD,
  },
];
