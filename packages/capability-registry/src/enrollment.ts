/**
 * Certificate enrollment protocol endpoints (ADR 0068).
 *
 * EST (RFC 7030) at `/.well-known/est/{profileId}/*` is spoken by protocol
 * clients — enrollment-capable network gear, MDMs, and the browser
 * provisioning journey's own fetch — never by an agent. ADR 0068 §8 excludes
 * every enrollment endpoint from every agent surface: an enrollment
 * credential authorizes exactly one certificate and nothing else, and handing
 * enrollment to a model would hand it a signing oracle.
 */
import type { Capability } from "./index.js";

const ENROLLMENT_IS_A_PROTOCOL_SURFACE = {
  reason:
    "an enrollment endpoint is spoken by a protocol client, not by an agent (ADR 0068 §8)",
  adr: "0068-enrollment-protocol-servers.md",
} as const;

export const enrollmentCapabilities: readonly Capability[] = [
  {
    id: "certificates.est.enrollment",
    title: "Enroll a client certificate over EST (RFC 7030)",
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
      cli: ENROLLMENT_IS_A_PROTOCOL_SURFACE,
      mcp_host: ENROLLMENT_IS_A_PROTOCOL_SURFACE,
      mcp_client: ENROLLMENT_IS_A_PROTOCOL_SURFACE,
      webmcp: ENROLLMENT_IS_A_PROTOCOL_SURFACE,
    },
  },
];
