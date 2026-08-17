export interface AuthMdConfig {
  serviceName: string;
  protectedResource: string;
  authorizationServer: string;
  consoleOrigin: string;
  agentRegisterPath?: string;
  provisionalPath?: string;
  claimPath?: string;
  devicePath?: string;
  registrationModes?: string[];
  proofKeyMechanism?: string;
  preClaimRestrictions?: string[];
  postClaimBehavior?: string;
  tokenAudiences?: string[];
  pollIntervalSeconds?: number;
  claimTtlSeconds?: number;
}

export function renderAuthMd(config: AuthMdConfig): string {
  // Defaults must be paths the control plane actually mounts (/v1, app.ts) —
  // a documented endpoint that 404s teaches every reader the wrong ceremony.
  const registerPath = config.agentRegisterPath ?? "/v1/agents";
  const provisionalPath =
    config.provisionalPath ?? "/v1/principals/provisional";
  const claimPath = config.claimPath ?? "/claim";
  const devicePath = config.devicePath ?? "/device";
  const modes = (config.registrationModes ?? ["anonymous", "pre_registered"]).join(
    ", ",
  );
  const proof = config.proofKeyMechanism ?? "JWK thumbprint (publicKeyJkt)";
  const preClaim = (
    config.preClaimRestrictions ?? [
      "short-lived credentials only",
      "no durable ownership",
      "resource-limited grants",
    ]
  )
    .map((x) => `- ${x}`)
    .join("\n");
  const postClaim =
    config.postClaimBehavior ??
    "Human principal owns or delegates to the agent actor; principal id stays distinct from agent id.";
  const audiences = (config.tokenAudiences ?? [config.protectedResource]).join(", ");
  const poll = config.pollIntervalSeconds ?? 5;
  const ttl = config.claimTtlSeconds ?? 900;

  return `# ${config.serviceName} authentication

This document is generated from live OpenSesame configuration.

## Protected resource

\`${config.protectedResource}\`

## Authorization server

\`${config.authorizationServer}\`

OIDC discovery: \`${config.authorizationServer}/.well-known/openid-configuration\`

## Client registration modes

${modes}

## Guest (anonymous) session — humans and agents

\`POST ${config.authorizationServer}${provisionalPath}\`

No account is needed: the response is a provisional principal and a short-lived
bearer. Claiming later — linking an upstream identity — keeps the same
principal id, so nothing created as a guest is lost.
Revoke: \`POST ${config.authorizationServer}${provisionalPath}/revoke\`

## Anonymous agent bootstrap

\`POST ${config.authorizationServer}${registerPath}\`

Registration authenticates as a principal, which may itself be provisional
(guest). Agents register with a proof key (${proof}) and receive a claim
session for a human to take ownership later.
No long-lived secrets are returned in this document.

## Claim ceremony

Human claim UI: \`${config.consoleOrigin}${claimPath}\`

Claim tokens use fragment transport (\`#token=\`) and must be POSTed — never logged.

Claim TTL: ${ttl}s · recommended poll interval: ${poll}s

## Device / headless UX

Device approval UI: \`${config.consoleOrigin}${devicePath}\`

CLIs should use RFC 8628 device authorization or RFC 8252 loopback.
Never print \`device_code\` values.

## Pre-claim restrictions

${preClaim}

## Post-claim behavior

${postClaim}

## Token / resource audiences

${audiences}

## Secrets policy

This document must never embed client secrets, private keys, bearer tokens, or reusable credentials.
`;
}

export interface AgentCardConfig {
  name: string;
  description?: string;
  url: string;
  version?: string;
  preferredTransport?: string;
  additionalTransports?: string[];
  authenticationSchemes?: string[];
  capabilities?: string[];
  claimSupport?: boolean;
  documentationUrl?: string;
}

export function renderAgentCard(config: AgentCardConfig): Record<string, unknown> {
  return {
    name: config.name,
    description:
      config.description ??
      "OpenSesame agent-facing identity and claim service",
    url: config.url,
    version: config.version ?? "0.1.0",
    preferredTransport: config.preferredTransport ?? "http",
    additionalInterfaces: (config.additionalTransports ?? []).map((t) => ({
      transport: t,
      url: config.url,
    })),
    authentication: {
      schemes: config.authenticationSchemes ?? [
        "openid",
        "oauth2_device",
        "claim_session",
      ],
    },
    capabilities: {
      claimSupport: config.claimSupport ?? true,
      features: config.capabilities ?? [
        "anonymous_register",
        "claim_poll",
        "device_authorization",
      ],
    },
    documentationUrl:
      config.documentationUrl ?? `${config.url.replace(/\/+$/u, "")}/auth.md`,
    // Explicitly absent: credentials, tokens, private endpoints
  };
}
