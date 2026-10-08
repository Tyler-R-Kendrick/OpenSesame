/**
 * Optional descriptors — sharing. Default off; each is chosen, reviewed and
 * accepted before its module is fetched. Git backup is always on
 * (`catalog-always-on-local.ts`, ADR 0142).
 */

import { DERIVED_ITEM_KINDS } from "../derived-item-kinds.js";
import { type AuthoredDescriptor, optional } from "./descriptor.js";

/**
 * What `sharing.live` declares for its external-service egress. Egress
 * classifies a request by the purpose it names, exactly, so the carrier code
 * imports this rather than retype it.
 */
export const LIVE_CARRIER_PURPOSE =
  "only STUN/TURN servers and code carriers (Nostr, MQTT, NATS, ntfy) the owner names in Routes; joiners see them first";

/**
 * What `vault.security-checks` declares for its two external services. The
 * checks (`lib/vault/security-checks.ts`) import these rather than retype
 * them: egress matches a purpose exactly.
 */
export const PWNED_PURPOSE =
  "Have I Been Pwned's password range API: five hex characters of a password's SHA-1, never the password";
export const TWO_FACTOR_PURPOSE =
  "2fa.directory's public list of sites that take an authenticator code, fetched whole";

/**
 * What Settings says `vault.security-checks` does. The capabilities section
 * shows this while the switch is off; the check panel shows it once the
 * capability is on. Kept under the catalog's 400-character summary limit.
 */
export const SECURITY_CHECKS_SUMMARY =
  "Compares the open vault's logins with known password breaches and with sites that offer an authenticator code you have not stored. With this on, Settings and Password health show how many passwords were found and which logins could add a second step. Press Check to run it. Only five characters of each password's hash leave this browser; the two-step site list is fetched whole and matched here.";

export const VAULT_FAMILY_DESCRIPTORS: readonly AuthoredDescriptor[] = [
  optional(
    "vault.derived-records",
    "Derived item types",
    "Login, note, card and the other built-in item types. Each projects onto the base secret. The minimal vault creates secrets and files.",
    { itemKinds: [...DERIVED_ITEM_KINDS] },
  ),
  optional(
    "sharing.live",
    "Live sessions",
    "Share the whole vault or chosen items live with people who join from a link — browser to browser, paired by codes the two people pass each other, while this tab stays open — and join somebody else's session from the front door. No server is needed; routes the owner names (a tailnet address, STUN or TURN, a code carrier) are optional, and nothing of a session is stored on either side.",
    {
      operationIds: ["shared_sessions.live_host", "shared_sessions.live_join"],
      egress: [
        {
          class: "peer-or-local-network",
          purpose:
            "the other person's browser over WebRTC — directly, or through a tunnel address the owner names",
          automatic: false,
        },
        {
          class: "external-service",
          purpose: LIVE_CARRIER_PURPOSE,
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
        "Both browsers must reach each other: the same network, a tunnel address, or a TURN server the owner names; a session ends when the owner's tab closes.",
    },
  ),
  optional(
    "vault.environments",
    "Environments",
    "Named values for vault items.",
  ),
  optional(
    "storage.encrypted-search",
    "Encrypted search",
    "Keep the stores that hold identifiers - history backups and retired-password digests - in encrypted databases where no table, field, id or name is readable on disk, and search them by blind index (equality, order, keywords) without opening the rest. A field is searchable only once a query has needed it, and stops being the moment it is dropped (ADR 0175).",
    {
      keyAccess: ["item-plaintext", "protector-wrap"],
      offlineLimits:
        "Works offline. The databases belong to this device and this browser profile: they are not synced, and are unreadable without the device key.",
    },
  ),
  optional(
    "vault.security-checks",
    "Breach and two-step checks",
    SECURITY_CHECKS_SUMMARY,
    {
      operationIds: ["vault.health.security_check"],
      egress: [
        { class: "external-service", purpose: PWNED_PURPOSE, automatic: false },
        {
          class: "external-service",
          purpose: TWO_FACTOR_PURPOSE,
          automatic: false,
        },
      ],
      keyAccess: "item-plaintext",
      offlineLimits:
        "A check needs both services; offline, the last results stay until the tab closes.",
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
