import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_GENERAL_AUTHORITY = "0120-generalized-hierarchical-authority.md";
const ADR_AGENT_SURFACE_PARITY = "0065-agent-surface-parity.md";
const ADR_ACCESS_PORTAL = "0101-access-portal-authority-workflows.md";

/**
 * Issuing, reshaping or ending hierarchical authority is a human decision.
 * An agent that could create a domain, mint a grant or rewrite a portal
 * template could admit itself or reshape somebody else's ceiling.
 */
const AUTHORITY_HUMAN_CEREMONY: CapabilityExclusion = {
  reason:
    "generalized hierarchical authority is conferred by a human; an agent surface that could issue, reshape or terminate it would make the ceremony decorative",
  adr: ADR_GENERAL_AUTHORITY,
};

/**
 * Portal templates shape the Access review UI. Agents may navigate; they must
 * not author what a human is then asked to approve.
 */
const PORTAL_TEMPLATE_HUMAN: CapabilityExclusion = {
  reason:
    "a portal template decides what a human is asked to review; an agent that could install or rewrite one could shape that prompt",
  adr: ADR_ACCESS_PORTAL,
};

const AUTHORITY_READ_DEFERRED: CapabilityExclusion = {
  reason:
    "authority domain and cohort reads are not yet exposed to agents; map a scoped projection deliberately rather than by accretion",
  adr: ADR_AGENT_SURFACE_PARITY,
};

const NONE = {
  cli: null,
  pwa: null,
  mcp_host: null,
  mcp_client: null,
  webmcp: null,
} as const;

const HUMAN_EXCLUDED = {
  cli: AUTHORITY_HUMAN_CEREMONY,
  mcp_host: AUTHORITY_HUMAN_CEREMONY,
  mcp_client: AUTHORITY_HUMAN_CEREMONY,
  webmcp: AUTHORITY_HUMAN_CEREMONY,
} as const;

const READ_EXCLUDED = {
  cli: AUTHORITY_READ_DEFERRED,
  mcp_host: AUTHORITY_READ_DEFERRED,
  mcp_client: AUTHORITY_READ_DEFERRED,
  webmcp: AUTHORITY_READ_DEFERRED,
} as const;

const PORTAL_EXCLUDED = {
  cli: PORTAL_TEMPLATE_HUMAN,
  mcp_host: PORTAL_TEMPLATE_HUMAN,
  mcp_client: PORTAL_TEMPLATE_HUMAN,
  webmcp: PORTAL_TEMPLATE_HUMAN,
} as const;

/**
 * Generalized hierarchical authority surfaces (ADR 0120 / GA-C-01).
 *
 * Capability ids use the `authority.*` prefix so fabric scenario GA-V-30 has a
 * non-vacuous subject set. Surfaces are not yet shipped on agent planes; each
 * entry carries an ADR-cited exclusion so the parity sweep sees a decision.
 */
export const generalAuthorityCapabilities: readonly Capability[] = [
  {
    id: "authority.domain.create",
    title: "Create an access domain in a realm",
    plane: "host",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.domain.reparent",
    title: "Move an access domain within its realm",
    plane: "host",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.domain.terminate",
    title: "Terminate an access domain and fence its subtree",
    plane: "host",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.domain.read",
    title: "Read access domains in a realm",
    plane: "host",
    kind: "read",
    surfaces: { ...NONE },
    excluded: { ...READ_EXCLUDED },
  },
  {
    id: "authority.cohort.create",
    title: "Create a cohort (eligibility group)",
    plane: "host",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.cohort.update",
    title: "Replace a cohort's membership or admission mode",
    plane: "host",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.cohort.activate",
    title: "Bind one eligible principal to a request via cohort activation",
    plane: "host",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.cohort.read",
    title: "Read cohorts and their declared admission mode",
    plane: "host",
    kind: "read",
    surfaces: { ...NONE },
    excluded: { ...READ_EXCLUDED },
  },
  {
    id: "authority.grant.issue",
    title: "Issue generalized hierarchical authority for a grant",
    plane: "host",
    kind: "ceremony",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.portal.templates.manage",
    title: "Install or revise Access portal authority templates",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { ...PORTAL_EXCLUDED },
  },
  {
    id: "authority.portal.templates.read",
    title: "Read Access portal authority templates",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: "route:/access",
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: { ...READ_EXCLUDED },
  },

  {
    id: "authority.workload.spawn",
    title: "Mint a workload identity (Identity spawn; no Host grant)",
    plane: "identity",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
  {
    id: "authority.enrollment.pop",
    title: "Bind proof-of-possession for an authority principal",
    plane: "identity",
    kind: "admin",
    surfaces: { ...NONE },
    excluded: { ...HUMAN_EXCLUDED },
  },
];
