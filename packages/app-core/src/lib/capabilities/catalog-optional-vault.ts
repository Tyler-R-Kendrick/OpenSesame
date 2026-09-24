/**
 * Optional descriptors — sharing. Default off; each is chosen, reviewed and
 * accepted before its module is fetched. Git backup is always on
 * (`catalog-always-on-local.ts`, ADR 0140).
 */

import { type AuthoredDescriptor, optional } from "./descriptor.js";

export const VAULT_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "sharing.drops",
    "Secret drops",
    "Share a secret or a small file exactly once through a sealed claim session; the drop kind, its ceremonies and the claim screen.",
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
          purpose: "the drop link a person copies or opens",
          automatic: false,
        },
      ],
      browserPermissions: ["clipboard-write"],
      keyAccess: "item-plaintext",
      itemKinds: ["drop"],
      offlineLimits:
        "Creating or opening a drop needs the claim host; sealed drops already in the vault still list.",
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
