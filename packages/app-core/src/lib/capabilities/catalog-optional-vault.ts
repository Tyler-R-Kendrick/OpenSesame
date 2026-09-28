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
    "Share chosen vault items live with people who join from a link — browser to browser, paired by codes the two people pass each other, while this tab stays open — and join somebody else's session from the front door. No server is needed; routes you name (a tailnet address, STUN or TURN, a code carrier) are optional, and nothing of a session is stored on either side.",
    {
      operationIds: ["shared_sessions.live_host", "shared_sessions.live_join"],
      egress: [
        {
          class: "peer-or-local-network",
          purpose:
            "the other person's browser over WebRTC — directly, or through a tunnel address you name",
          automatic: false,
        },
        {
          class: "external-service",
          purpose:
            "only STUN or TURN servers and code carriers (Nostr, MQTT, NATS, ntfy) you name in Routes",
          automatic: false,
        },
        {
          class: "user-mediated-navigation",
          purpose:
            "the session link and pairing codes a person copies and sends themselves",
          automatic: false,
        },
      ],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      offlineLimits:
        "Both browsers must reach each other: the same network, a tunnel address, or a TURN server you name; a session ends when the owner's tab closes.",
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
