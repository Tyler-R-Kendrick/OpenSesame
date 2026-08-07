export interface AuthMdConfig {
  serviceName: string;
  protectedResource: string;
  authorizationServer: string;
  consoleOrigin: string;
  agentRegisterPath?: string;
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
  const registerPath = config.agentRegisterPath ?? "/api/v1/agents/register";
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

## Anonymous agent bootstrap

\`POST ${config.authorizationServer}${registerPath}\`

Agents may register with a proof key (${proof}) and receive a claim session.
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
