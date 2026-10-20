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
  "Checks the open vault's logins against known password breaches and sites that offer an authenticator code you have not stored. Hash prefixes only leave this browser.";

/**
 * What Settings says `vault.environments` does (ADR 0194). Kept under the
 * catalog's 400-character summary limit.
 */
export const ENVIRONMENTS_SUMMARY =
  "Give a vault's standalone secrets a value for each environment (development, staging, production), folder-prefixed where they are filed, and mark each required where it must have one. One .env.<name>.schema is generated per environment with item bindings but no values; a required key with no value is flagged in the bell. Adds an Environments key to the vault. Values stay sealed in the vault.";

/**
 * What Settings says `sharing.trusted-contacts` does. Kept under the catalog's
 * 400-character summary limit.
 */
export const TRUSTED_CONTACTS_SUMMARY =
  "Name people you trust and, if you choose, require a quorum of them: a request is honoured only when enough of them approve it with their own security keys, and a recovery key is split so that no one contact, or small group, can open it. A short delay gives you time to object. Nothing is stored with a service; their devices do the work (ADR 0187).";

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
    "Share the whole vault or chosen items live with people who join from a link — browser to browser, while this tab stays open — and join somebody else's session from the front door. The owner may also let a terminal use saved connections: read-only, and it never holds a credential. No server is needed; routes the owner names are optional, and nothing of a session is stored.",
    {
      operationIds: [
        "shared_sessions.live_host",
        "shared_sessions.live_join",
        "shared_sessions.device_authorize",
        "shared_sessions.device_connections",
        "shared_sessions.device_invoke",
      ],
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
  optional("vault.environments", "Environments", ENVIRONMENTS_SUMMARY, {
    operationIds: ["vault.environments.manage"],
    keyAccess: "item-plaintext",
    offlineLimits:
      "Works offline. Values are sealed in the vault body with everything else and sync with it; nothing is fetched.",
  }),
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
  optional(
    "sharing.trusted-contacts",
    "Trusted contacts",
    TRUSTED_CONTACTS_SUMMARY,
    {
      operationIds: [
        "quorum.circle.manage",
        "quorum.share.ask",
        "quorum.guardian.hold",
        "quorum.request.approve",
        "quorum.recover",
      ],
      // Security keys do the approving; a packet is copied by hand. No request
      // is made by this capability: people carry the packets themselves.
      browserPermissions: ["webauthn", "clipboard-write"],
      egress: [
        {
          class: "user-mediated-navigation",
          purpose:
            "the invitations, requests and approvals a person copies and hands to another person over a road they already trust",
          automatic: false,
        },
      ],
      keyAccess: ["item-plaintext", "protector-wrap"],
      offlineLimits:
        "Works offline. A request waits for enough of the contacts' own security keys, and for the delay the owner set.",
    },
  ),
  optional(
    "sharing.relay",
    "Vault relay",
    "Publish a sealed vault snapshot to a relay the owner pairs, and pull it onto another device. The relay stores ciphertext and a generation. It does not hold a vault key.",
    {
      keyAccess: "none",
      offlineLimits:
        "A push or pull waits until the paired relay answers. The vault stays on this device either way.",
    },
  ),
];
