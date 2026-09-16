/**
 * Built-in audience templates — declarative versioned defaults (ADR 0120).
 *
 * Adding an audience is data: register another entry here (or load one through
 * {@link parseAudienceTemplate}). Authorization still runs through Grant /
 * AccessDomain; labels never become engine branches.
 */

import { EXTENDED_AUDIENCE_TEMPLATE_SOURCE } from "./catalog-extended.js";
import { parseAudienceTemplateCatalog } from "./parse.js";
import type { AudienceTemplate } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Primary portal audiences called out by ADR 0120. */
const PRIMARY_CATALOG_SOURCE = [
  {
    id: "family",
    version: "1.0.0",
    label: "Family / shared devices",
    summary:
      "Household domain with guardian and participant vocabulary, scheduled access, and transparent usage limits.",
    vocabulary: {
      domain: "Household",
      participant: "Participant",
      supervisor: "Guardian",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "inherit",
      defaultLifetimeMs: 7 * DAY_MS,
      maxLifetimeMs: 30 * DAY_MS,
      suggestedVerbs: ["request", "approve", "narrow", "revoke"],
      usageAccounting: "per_device",
    },
    limits: {
      maxDelegationDepth: 2,
      forbidSecretReadFromSupervision: true,
      requireIndependentApprover: false,
    },
    supportMatrix: [
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "configuration_required",
        note: "Adapter crate exists; the portal leaves DNS blocking off until an operator wires and verifies it.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "No verified portal wiring.",
      },
    ],
    workflowHints: [
      "scheduled access",
      "bounded usage",
      "request extra access",
      "verified approval",
      "narrow exception",
      "expiry",
    ],
  },
  {
    id: "contractor",
    version: "1.0.0",
    label: "Contractor engagement",
    summary:
      "Engagement subdomain with scoped external principals, JIT access, and end-of-engagement termination.",
    vocabulary: {
      domain: "Engagement",
      participant: "Contractor",
      supervisor: "Sponsor",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: 14 * DAY_MS,
      maxLifetimeMs: 30 * DAY_MS,
      suggestedVerbs: ["invite", "approve", "narrow", "revoke", "terminate"],
    },
    limits: {
      maxDelegationDepth: 3,
      requireIndependentApprover: true,
      endOfEngagementTerminates: true,
      forbidSecretReadFromSupervision: true,
    },
    supportMatrix: [
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "configuration_required",
        note: "Off by default in the portal.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "No verified implementation on this surface.",
      },
    ],
    workflowHints: [
      "JIT resource access",
      "independent approvers",
      "sponsor removal",
      "end-of-engagement termination",
    ],
  },
  {
    id: "raid",
    version: "1.0.0",
    label: "Gaming raid",
    summary:
      "Temporary raid session with roster roles, late admission under a ceiling, and leave/end cleanup.",
    vocabulary: {
      domain: "Raid",
      participant: "Raider",
      supervisor: "Raid lead",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: 8 * 60 * 60 * 1000,
      maxLifetimeMs: DAY_MS,
      suggestedVerbs: ["invite", "claim", "observe", "moderate", "end"],
    },
    limits: {
      maxDelegationDepth: 2,
      observerOnlyAllowed: true,
      endOfEngagementTerminates: true,
    },
    supportMatrix: [
      {
        id: "discord.moderation",
        label: "Discord moderation",
        status: "configuration_required",
        note: "Role ops do not guarantee provider-wide session cleanup or timely voice/game termination.",
      },
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "unsupported",
        note: "Not part of the raid portal path.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Not claimed on the raid portal path.",
      },
    ],
    workflowHints: [
      "invite/claim",
      "observer-only",
      "late admission under ceiling",
      "leave/end cleanup",
    ],
  },
];

/** Schema-validated built-in catalog. Throws if the const drifts from schema. */
export const AUDIENCE_TEMPLATES: readonly AudienceTemplate[] =
  parseAudienceTemplateCatalog([
    ...PRIMARY_CATALOG_SOURCE,
    ...EXTENDED_AUDIENCE_TEMPLATE_SOURCE,
  ]);

export function getAudienceTemplate(id: string): AudienceTemplate | undefined {
  return AUDIENCE_TEMPLATES.find((template) => template.id === id);
}

export function listAudienceTemplates(): readonly AudienceTemplate[] {
  return AUDIENCE_TEMPLATES;
}
