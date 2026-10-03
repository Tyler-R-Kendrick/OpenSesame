import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_MTLS = "0132-optional-mtls-and-workload-identity.md";

/**
 * Transport configuration is authority (ADR 0132 § configuration): trust
 * roots, service bindings, identity sources and enforcement probes are
 * mutated only under the existing operator authorization, and an agent
 * surface that could touch them could bind itself to a service principal.
 */
const OPERATOR_TRANSPORT_AUTHORITY: CapabilityExclusion = {
  reason:
    "trust, identity-source and service-binding configuration is deployment-plane authority under operator authorization; an agent that could change it could bind its own certificate to a service principal",
  adr: ADR_MTLS,
};

const PROBE_IS_AUTHORIZED_EGRESS: CapabilityExclusion = {
  reason:
    "the verification probe makes outbound connections with and without the service certificate; an agent-reachable probe is an egress and signing oracle, so it stays an operator action",
  adr: ADR_MTLS,
};

const STATUS_IS_OPERATOR_TOPOLOGY: CapabilityExclusion = {
  reason:
    "transport status names listeners, generations and peer thumbprints across the deployment; it is operator observability, not something an agent acting for one tenant reads",
  adr: ADR_MTLS,
};

const REFERENCE_ONLY_VIA_CONNECTIONREF: CapabilityExclusion = {
  reason:
    "an agent never selects a transport identity directly; a connector's identity reference is bound to its ConnectionRef by an operator, and the agent holds only the ConnectionRef",
  adr: ADR_MTLS,
};

/**
 * What a static page can do about TLS is fixed, not discovered: no vault key
 * reaches a handshake and `fetch` selects no certificate (ADR 0132 §2, §14).
 * Pages carries no transport surface at all — no status panel, no probe, no
 * identity reference — so there is nothing for it to discover or display.
 */
const BROWSER_BOUNDARY_IS_FIXED: CapabilityExclusion = {
  reason:
    "a static page's transport capabilities are fixed by the browser boundary (no vault key in a handshake, no certificate selection through fetch), so Pages carries no transport surface: status, probe and identity reference are Host-plane operator work",
  adr: ADR_MTLS,
};

export const transportSecurityCapabilities: readonly Capability[] = [
  // ── Host plane: optional mTLS and workload identity (ADR 0132) ────────
  {
    id: "transport.status.view",
    title:
      "Read desired policy, credential, runtime, observation and enforcement status per target",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: BROWSER_BOUNDARY_IS_FIXED,
      mcp_host: STATUS_IS_OPERATOR_TOPOLOGY,
      mcp_client: STATUS_IS_OPERATOR_TOPOLOGY,
      webmcp: STATUS_IS_OPERATOR_TOPOLOGY,
    },
  },
  {
    id: "transport.bindings.manage",
    title: "Read and replace the service binding set (revisioned, CAS)",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: OPERATOR_TRANSPORT_AUTHORITY,
      mcp_client: OPERATOR_TRANSPORT_AUTHORITY,
      webmcp: OPERATOR_TRANSPORT_AUTHORITY,
    },
  },
  {
    id: "transport.trust.manage",
    title: "Read and replace registered trust profiles",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      mcp_host: OPERATOR_TRANSPORT_AUTHORITY,
      mcp_client: OPERATOR_TRANSPORT_AUTHORITY,
      webmcp: OPERATOR_TRANSPORT_AUTHORITY,
    },
  },
  {
    id: "transport.verify.run",
    title: "Run the positive/negative enforcement probe against a target",
    plane: "host",
    kind: "act",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: PROBE_IS_AUTHORIZED_EGRESS,
      mcp_host: PROBE_IS_AUTHORIZED_EGRESS,
      mcp_client: PROBE_IS_AUTHORIZED_EGRESS,
      webmcp: PROBE_IS_AUTHORIZED_EGRESS,
    },
  },
  {
    id: "transport.identity.reference",
    title:
      "Select a registered identity source by public reference (never a path or socket)",
    plane: "host",
    kind: "admin",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: REFERENCE_ONLY_VIA_CONNECTIONREF,
      mcp_host: REFERENCE_ONLY_VIA_CONNECTIONREF,
      mcp_client: REFERENCE_ONLY_VIA_CONNECTIONREF,
      webmcp: REFERENCE_ONLY_VIA_CONNECTIONREF,
    },
  },
  {
    id: "transport.capabilities.discover",
    title:
      "Discover which identity sources this runtime supports and whether it presents or enforces certificates",
    plane: "host",
    kind: "read",
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
    },
    excluded: {
      pwa: BROWSER_BOUNDARY_IS_FIXED,
      mcp_host: STATUS_IS_OPERATOR_TOPOLOGY,
      mcp_client: STATUS_IS_OPERATOR_TOPOLOGY,
      webmcp: STATUS_IS_OPERATOR_TOPOLOGY,
    },
  },
];
