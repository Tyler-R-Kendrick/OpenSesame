import { type JsonObject, isString } from "@opensesame/os-domain";
import {
  AGENT_CLAIM_GRANT,
  AGENT_CLAIM_PATH,
  AGENT_IDENTITY_PATH,
  AGENT_REVOKE_PATH,
  AGENT_TOKEN_PATH,
  AUTH_MD_PROFILE,
  JWT_BEARER_GRANT,
} from "./constants.js";

export interface AgentAuthCapability {
  anonymous: boolean;
  serviceAuth: boolean;
  providerAssertion: boolean;
  events: boolean;
}

export interface AuthMdConfig {
  serviceName: string;
  protectedResource: string;
  authorizationServer: string;
  consoleOrigin: string;
  resourceName?: string;
  resourceLogoUri?: string;
  scopes?: readonly string[];
  preClaimScopes?: readonly string[];
  postClaimScopes?: readonly string[];
  identityTypes?: readonly string[];
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
  termsUrl?: string;
  privacyUrl?: string;
  contactUrl?: string;
  capabilities?: AgentAuthCapability;
}

function assertSafeText(label: string, value: string): void {
  const lower = value;
  if (
    lower.includes("sk_live") ||
    lower.includes("sk_test") ||
    lower.includes("BEGIN PRIVATE KEY") ||
    lower.includes("BEGIN RSA PRIVATE KEY") ||
    lower.includes("osc_clm_") ||
    /\bdevice_code\b/.test(lower) ||
    /Bearer [A-Za-z0-9\-_]{20,}/.test(lower)
  ) {
    throw new Error(`agent_protocol_secret_refused:${label}`);
  }
}

function assertSafeConfig(
  label: string,
  value: AuthMdConfig | AgentCardConfig | JsonObject,
): void {
  const serialized = JSON.stringify(value);
  if (!isString(serialized)) {
    throw new Error(`agent_protocol_invalid_config:${label}`);
  }
  assertSafeText(label, serialized);
}

function capabilitiesOf(config: AuthMdConfig): AgentAuthCapability {
  return (
    config.capabilities ?? {
      anonymous: true,
      serviceAuth: true,
      providerAssertion: false,
      events: false,
    }
  );
}

function identityTypesOf(config: AuthMdConfig): string[] {
  const caps = capabilitiesOf(config);
  if (config.identityTypes) return [...config.identityTypes];
  const types: string[] = [];
  if (caps.anonymous) types.push("anonymous");
  if (caps.serviceAuth) types.push("service_auth");
  if (caps.providerAssertion) types.push("identity_assertion");
  return types;
}

export function renderAuthMd(config: AuthMdConfig): string {
  assertSafeConfig("authMd", config);
  const caps = capabilitiesOf(config);
  const as = config.authorizationServer.replace(/\/+$/u, "");
  const resource = `${config.protectedResource.replace(/\/+$/u, "")}/`;
  const identityPath = config.agentRegisterPath ?? AGENT_IDENTITY_PATH;
  const claimPath = AGENT_CLAIM_PATH;
  const types = identityTypesOf(config);
  const pre = config.preClaimScopes ?? [
    "resource:read",
    "resource:create:temporary",
  ];
  const post = config.postClaimScopes ?? [
    "resource:read",
    "resource:create:temporary",
    "project:create:temporary",
    "claim:create",
  ];
  const scopes = config.scopes ?? [...new Set([...pre, ...post])];
  const poll = config.pollIntervalSeconds ?? 5;
  const ttl = config.claimTtlSeconds ?? 86_400;
  const links = [
    config.termsUrl ? `- terms: ${config.termsUrl}` : "",
    config.privacyUrl ? `- privacy: ${config.privacyUrl}` : "",
    config.contactUrl ? `- contact: ${config.contactUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const anonymousSection = caps.anonymous
    ? `### anonymous

\`\`\`http
POST ${identityPath}
Content-Type: application/json

{ "type": "anonymous" }
\`\`\`

Response (200) includes a service-signed \`identity_assertion\` (JWT \`typ: os-sia+jwt\`),
\`pre_claim_scopes\`, a one-time \`claim_token\` (\`clm_…\`), and \`post_claim_scopes\`.
Exchange the assertion at \`${AGENT_TOKEN_PATH}\` immediately. The claim ceremony is optional.
`
    : "";

  const serviceAuthSection = caps.serviceAuth
    ? `### service_auth

\`\`\`http
POST ${identityPath}
Content-Type: application/json

{ "type": "service_auth", "login_hint": "<email>" }
\`\`\`

\`login_hint\` is not proof of identity and is not used to look up or merge accounts.
The response has a \`claim\` block (\`user_code\`, \`verification_uri\`, \`expires_in\`, \`interval\`)
and **no** identity assertion until the user completes the ceremony.
`
    : "";

  const md = `# auth.md

You are an agent. **${config.serviceName}** supports agentic registration:
discover → register → (claim if needed) → exchange for an access_token → call API → handle revocation.

Profile: \`${AUTH_MD_PROFILE}\`. This is a WorkOS ecosystem protocol, not an IETF RFC.
Runtime metadata at the Protected Resource Metadata and Authorization Server metadata URLs
is authoritative if this file and those documents disagree.

Resource: \`${resource}\`
Authorization server: \`${as}\`

## Step 1 — Discover

A 401 from the resource includes:

\`\`\`http
WWW-Authenticate: Bearer resource_metadata="${resource}.well-known/oauth-protected-resource"
\`\`\`

### 1a. Protected Resource Metadata

\`GET ${resource}.well-known/oauth-protected-resource\`

### 1b. Authorization Server metadata

\`GET ${as}/.well-known/oauth-authorization-server\`

Read \`agent_auth\` in full. Identity types actually enabled: ${types.join(", ") || "(none)"}.
Provider ID-JAG (\`identity_assertion\`) is ${caps.providerAssertion ? "enabled" : "not advertised and not enabled"}.
SET events are ${caps.events ? "enabled" : "not advertised and not enabled"}.

## Step 2 — Pick a method

1. No user identity → \`anonymous\` (if enabled).
2. Email hint only → \`service_auth\` (if enabled).
3. Provider ID-JAG → not accepted unless discovery lists \`identity_assertion\`.

## Step 3 — Register

${anonymousSection}${serviceAuthSection}
Do not send a product provisional bearer (\`pst_…\`) or a product claim token (\`osc_clm_…\`) here.

## Step 4 — Claim ceremony

For anonymous, start a ceremony:

\`\`\`http
POST ${claimPath}
Content-Type: application/json

{ "claim_token": "clm_…", "email": "user@example.com" }
\`\`\`

Surface \`verification_uri\` and \`user_code\` to the user. They sign in at OpenSesame
and type the code on a page OpenSesame owns. Poll:

\`\`\`http
POST ${AGENT_TOKEN_PATH}
Content-Type: application/x-www-form-urlencoded

grant_type=${AGENT_CLAIM_GRANT}&claim_token=clm_…
\`\`\`

Honor \`interval\` (${poll}s). Outer claim window: ${ttl}s.
On success the pre-claim access token is revoked; use the returned post-claim token.

## Step 5 — Exchange the assertion

\`\`\`http
POST ${AGENT_TOKEN_PATH}
Content-Type: application/x-www-form-urlencoded

grant_type=${JWT_BEARER_GRANT}&assertion=<identity_assertion>&resource=${resource}
\`\`\`

There is no OAuth refresh_token in this flow. Re-exchange the still-valid service
assertion. Service assertions use \`typ: os-sia+jwt\` and are not ID-JAGs.

## Step 6 — Use the access_token

\`Authorization: Bearer <aat_…>\` against \`${resource}\`.

## Revocation

Credential: \`POST ${as}${AGENT_REVOKE_PATH}\` (\`token\` + \`token_type_hint=access_token\`), RFC 7009.
Registration: owner-initiated revoke or expiry. Provider SET delivery is ${caps.events ? "enabled" : "not enabled"}.

## Scopes

- pre-claim: ${pre.join(", ")}
- post-claim: ${post.join(", ")}
- resource-supported: ${scopes.join(", ")}

Effective scopes are the intersection of requested, registration-state, resource-supported,
and domain policy. A signed assertion cannot grant a scope policy denies.

## Errors

| Code | Where | What to do |
| --- | --- | --- |
| anonymous_not_enabled | ${identityPath} | Use another enabled type |
| service_auth_not_enabled | ${identityPath} | Use another enabled type |
| identity_assertion_not_enabled | ${identityPath} | ID-JAG is not enabled |
| invalid_login_hint | ${identityPath} | login_hint must be an email |
| invalid_claim_token | ${claimPath} | Restart at Step 3 |
| claimed_or_in_flight | ${claimPath} | Follow the Step 3 response |
| claim_expired | ${claimPath} | Restart at Step 3 |
| invalid_grant | ${AGENT_TOKEN_PATH} | Assertion expired/revoked; re-register |
| authorization_pending | ${AGENT_TOKEN_PATH} | Wait \`interval\` |
| expired_token | ${AGENT_TOKEN_PATH} | Re-init claim or re-register |
| slow_down | ${AGENT_TOKEN_PATH} | Increase interval |

Existing guest product APIs remain at \`POST ${as}${config.provisionalPath ?? "/v1/principals/provisional"}\`
(\`pst_…\` bearers). Those are not service identity assertions.

${links ? `## Links\n\n${links}\n` : ""}Existing RFC 8628 device authorization remains at the authorization server's /device endpoint.
Never print \`device_code\` values.

## Secrets policy

This document must never embed client secrets, private keys, bearer tokens, or reusable credentials.
`;
  return md;
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

export function renderAgentCard(config: AgentCardConfig): JsonObject {
  assertSafeConfig("agentCard", config);
  const card = {
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
        "agent_auth",
      ],
    },
    capabilities: {
      claimSupport: config.claimSupport ?? true,
      features: config.capabilities ?? [
        "anonymous_register",
        "claim_poll",
        "device_authorization",
        "jwt_bearer_assertion_exchange",
      ],
    },
    documentationUrl:
      config.documentationUrl ?? `${config.url.replace(/\/+$/u, "")}/auth.md`,
  };
  assertSafeConfig("agentCard.output", card);
  return card;
}

export function advertisedIdentityTypes(caps: AgentAuthCapability): string[] {
  const types: string[] = [];
  if (caps.anonymous) types.push("anonymous");
  if (caps.serviceAuth) types.push("service_auth");
  if (caps.providerAssertion) types.push("identity_assertion");
  return types;
}
