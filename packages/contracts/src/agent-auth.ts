import { z } from "zod";

export const AgentRegistrationKindSchema = z.enum([
  "anonymous",
  "service_auth",
  "provider_assertion",
]);

export const AgentIdentityAnonymousRequestSchema = z.object({
  type: z.literal("anonymous"),
});

export const AgentIdentityServiceAuthRequestSchema = z.object({
  type: z.literal("service_auth"),
  login_hint: z.string().min(1).max(320),
});

export const AgentIdentityProviderAssertionRequestSchema = z.object({
  type: z.literal("identity_assertion"),
  assertion_type: z.string().min(1),
  assertion: z.string().min(1),
});

export const AgentIdentityRequestSchema = z.discriminatedUnion("type", [
  AgentIdentityAnonymousRequestSchema,
  AgentIdentityServiceAuthRequestSchema,
  AgentIdentityProviderAssertionRequestSchema,
]);
export type AgentIdentityRequest = z.infer<typeof AgentIdentityRequestSchema>;

export const AgentClaimCeremonyBlockSchema = z.object({
  user_code: z.string(),
  expires_in: z.number().int().positive(),
  verification_uri: z.string().url(),
  interval: z.number().int().positive(),
});
export type AgentClaimCeremonyBlock = z.infer<
  typeof AgentClaimCeremonyBlockSchema
>;

export const AgentAnonymousRegistrationResponseSchema = z.object({
  registration_id: z.string(),
  registration_type: z.literal("anonymous"),
  identity_assertion: z.string(),
  assertion_expires: z.string().datetime(),
  pre_claim_scopes: z.array(z.string()),
  claim_url: z.string().url(),
  claim_token: z.string(),
  claim_token_expires: z.string().datetime(),
  post_claim_scopes: z.array(z.string()),
});
export type AgentAnonymousRegistrationResponse = z.infer<
  typeof AgentAnonymousRegistrationResponseSchema
>;

export const AgentServiceAuthRegistrationResponseSchema = z.object({
  registration_id: z.string(),
  registration_type: z.literal("service_auth"),
  claim_url: z.string().url(),
  claim_token: z.string(),
  claim_token_expires: z.string().datetime(),
  post_claim_scopes: z.array(z.string()),
  claim: AgentClaimCeremonyBlockSchema,
});
export type AgentServiceAuthRegistrationResponse = z.infer<
  typeof AgentServiceAuthRegistrationResponseSchema
>;

export const AgentIdentityErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export const AgentClaimInitRequestSchema = z.object({
  claim_token: z.string().min(1),
  email: z.string().min(1).max(320).optional(),
});
export type AgentClaimInitRequest = z.infer<typeof AgentClaimInitRequestSchema>;

export const AgentClaimInitResponseSchema = z.object({
  registration_id: z.string(),
  claim_attempt_id: z.string(),
  status: z.literal("initiated"),
  expires_at: z.string().datetime(),
  claim_attempt: AgentClaimCeremonyBlockSchema,
});
export type AgentClaimInitResponse = z.infer<
  typeof AgentClaimInitResponseSchema
>;

export const AgentClaimCompleteRequestSchema = z.object({
  claim_attempt_token: z.string().min(1),
  user_code: z.string().min(1),
});
export type AgentClaimCompleteRequest = z.infer<
  typeof AgentClaimCompleteRequestSchema
>;

export const AgentTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  identity_assertion: z.string().optional(),
  assertion_expires: z.string().datetime().optional(),
});
export type AgentTokenResponse = z.infer<typeof AgentTokenResponseSchema>;

export const AgentAuthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export const JWT_BEARER_GRANT =
  "urn:ietf:params:oauth:grant-type:jwt-bearer" as const;
export const AGENT_CLAIM_GRANT =
  "urn:workos:agent-auth:grant-type:claim" as const;

export const SERVICE_ASSERTION_TYP = "os-sia+jwt" as const;
export const PROVIDER_ID_JAG_TYP = "oauth-id-jag+jwt" as const;
