/**
 * Optional descriptors — sharing. Default off; each is chosen, reviewed and
 * accepted before its module is fetched. Git backup is always on
 * (`catalog-always-on-local.ts`, ADR 0142).
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

export const VAULT_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "sharing.drops",
    "Secret drops",
    "Send a secret or a small file exactly once through a sealed claim session, and keep track of it as a drop item. Opening a drop someone sent needs nothing switched on.",
    {
      egress: [
        {
          class: "external-service",
          purpose:
            "the configured Identity API's claim sessions, or this origin when Pages hosts the claim",
          automatic: false,
        },
        {
          class: "user-mediated-navigation",
          purpose: "the drop link a person copies",
          automatic: false,
        },
      ],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      itemKinds: ["drop"],
      offlineLimits:
        "Creating a drop needs the claim host; sealed drops already in the vault still list.",
    },
  ),
  optional(
    "sharing.live",
    "Live sessions",
    "Share chosen vault items live with people who join from a link — browser to browser, while this tab stays open — and join somebody else's session from the front door. Nothing of a session is stored on either side.",
    {
      operationIds: ["shared_sessions.live_host", "shared_sessions.live_join"],
      egress: [
        {
          class: "external-service",
          purpose:
            "public Nostr relays, which carry the encrypted handshake between two throwaway session keys and nothing else",
          automatic: false,
        },
        {
          class: "external-service",
          purpose:
            "public STUN servers, which tell each browser its own network address once the owner has admitted someone",
          automatic: false,
        },
        {
          class: "peer-or-local-network",
          purpose:
            "the other person's browser, directly, only after the owner admits them",
          automatic: false,
        },
        {
          class: "user-mediated-navigation",
          purpose: "the session link a person copies",
          automatic: false,
        },
      ],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      offlineLimits:
        "A live session needs both browsers online and a relay reachable; it ends when the owner's tab closes.",
    },
  ),
  optional(
    "sharing.household",
    "Household sharing",
    "Share chosen vault items with the people of one household over an explicitly chosen transport.",
    {
      alternatives: [{ slot: "transport", oneOf: ["sharing.drops"] }],
      keyAccess: "item-plaintext",
      offlineLimits: "Sharing waits until the chosen transport is reachable.",
    },
  ),
];
