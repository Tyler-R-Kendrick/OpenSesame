export const JWT_BEARER_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer" as const;
export const AGENT_CLAIM_GRANT =
  "urn:workos:agent-auth:grant-type:claim" as const;

/** OpenSesame service-signed identity assertion. Distinct from ID-JAG. */
export const SERVICE_ASSERTION_TYP = "os-sia+jwt" as const;
/** Provider ID-JAG typ from draft-ietf-oauth-identity-assertion-authz-grant-04. */
export const PROVIDER_ID_JAG_TYP = "oauth-id-jag+jwt" as const;
/** RFC 8693-style token type for an ID-JAG in auth.md registration bodies. */
export const ID_JAG_ASSERTION_TYPE =
  "urn:ietf:params:oauth:token-type:id-jag" as const;

export const AUTH_MD_PROFILE = "workos-auth.md/v0.6.0" as const;
export const ID_JAG_DRAFT =
  "draft-ietf-oauth-identity-assertion-authz-grant-04";

export const AGENT_IDENTITY_PATH = "/agent/identity" as const;
export const AGENT_CLAIM_PATH = "/agent/identity/claim" as const;
export const AGENT_CLAIM_COMPLETE_PATH =
  "/agent/identity/claim/complete" as const;
export const AGENT_TOKEN_PATH = "/oauth2/token" as const;
export const AGENT_REVOKE_PATH = "/oauth2/revoke" as const;
export const AGENT_CLAIM_PAGE_PATH = "/claim" as const;
export const AGENT_LOGIN_PATH = "/login" as const;
