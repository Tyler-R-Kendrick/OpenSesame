import { z } from "zod";

export const AgentStateSchema = z.enum([
  "provisional",
  "claimed",
  "suspended",
  "revoked",
]);

export const RegisterAgentRequestSchema = z.object({
  displayName: z.string().min(1).max(128),
  provider: z.string().optional(),
  softwareIdentity: z.string().optional(),
  publicKeyJkt: z.string().min(8),
  runtimeProvider: z.string().optional(),
  attestationDigest: z.string().optional(),
});
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>;

export const RegisterAgentResponseSchema = z.object({
  agentId: z.string(),
  instanceId: z.string(),
  state: z.literal("provisional"),
  claimId: z.string(),
  claimToken: z.string().regex(/^osc_clm_/),
  userCode: z.string(),
  verificationUri: z.string().url(),
  expiresAt: z.string().datetime(),
  preClaimCredentialHint: z.string().optional(),
});
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponseSchema>;

export const AgentResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: z.string().optional(),
  state: AgentStateSchema,
  createdAt: z.string().datetime(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
