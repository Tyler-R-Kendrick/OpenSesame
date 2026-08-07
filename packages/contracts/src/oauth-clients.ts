import { z } from "zod";

export const ClientAdmissionModeSchema = z.enum([
  "pre_registered",
  "dynamic_registration",
  "client_metadata_document",
  "origin_profile",
]);

export const OAuthClientStateSchema = z.enum([
  "active",
  "suspended",
  "revoked",
]);

export const CreateOAuthClientRequestSchema = z.object({
  displayName: z.string().min(1).max(128),
  redirectUris: z.array(z.string().url()).min(1),
  sectorIdentifier: z.string().min(1),
  grantTypes: z.array(z.string()).default(["authorization_code", "refresh_token"]),
  responseTypes: z.array(z.string()).default(["code"]),
  tokenEndpointAuthMethod: z.string().default("none"),
  allowedScopes: z.array(z.string()).default(["openid"]),
  allowedResources: z.array(z.string()).default([]),
  admissionMode: ClientAdmissionModeSchema.default("pre_registered"),
});
export type CreateOAuthClientRequest = z.infer<
  typeof CreateOAuthClientRequestSchema
>;

export const PatchOAuthClientRequestSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  redirectUris: z.array(z.string().url()).min(1).optional(),
  allowedScopes: z.array(z.string()).optional(),
  allowedResources: z.array(z.string()).optional(),
  state: OAuthClientStateSchema.optional(),
});
export type PatchOAuthClientRequest = z.infer<
  typeof PatchOAuthClientRequestSchema
>;

export const OAuthClientResponseSchema = z.object({
  id: z.string(),
  admissionMode: ClientAdmissionModeSchema,
  displayName: z.string(),
  redirectUris: z.array(z.string()),
  sectorIdentifier: z.string(),
  grantTypes: z.array(z.string()),
  responseTypes: z.array(z.string()),
  tokenEndpointAuthMethod: z.string(),
  allowedScopes: z.array(z.string()),
  allowedResources: z.array(z.string()),
  state: OAuthClientStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OAuthClientResponse = z.infer<typeof OAuthClientResponseSchema>;
