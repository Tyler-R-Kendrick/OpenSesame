import { PAGES_HAS_NO_HOST } from "./exclusions.js";
import type { Capability, CapabilityExclusion } from "./index.js";

const ADR_AWS_STS_MINT = "0217-aws-sts-mint.md";

/**
 * The STS binding on an aws-family Host connection (ADR 0217): which role a
 * mint assumes, in which region, for how long, under which session policy and
 * ExternalId. Operator configuration over the Host API; the mint it enables is
 * the existing `POST /connections/{id}/mint` (ADR 0049).
 */
const ROLE_IS_HUMAN: CapabilityExclusion = {
  reason:
    "a binding decides which IAM role a stored AWS key assumes and how long the credential lasts; an agent that could write one could re-aim the key at a role of its choosing",
  adr: ADR_AWS_STS_MINT,
};

const HOST_API_ONLY: CapabilityExclusion = {
  reason:
    "an operator writes the binding over the Host API once per connection; there is no terminal verb for it",
  adr: ADR_AWS_STS_MINT,
};

export const awsStsCapabilities: readonly Capability[] = [
  {
    id: "connections.aws_sts_binding",
    title: "Bind, read or remove the STS role an AWS connection mints for",
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
      cli: HOST_API_ONLY,
      pwa: PAGES_HAS_NO_HOST,
      webmcp: PAGES_HAS_NO_HOST,
      mcp_host: ROLE_IS_HUMAN,
      mcp_client: ROLE_IS_HUMAN,
    },
  },
];
