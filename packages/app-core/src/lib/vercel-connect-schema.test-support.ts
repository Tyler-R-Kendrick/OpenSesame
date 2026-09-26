/**
 * Vercel Connect's published create-connector request schema
 * (`POST /v1/connect/connectors`, "Full configuration" and "Preset
 * configuration" variants), transcribed for the fields our bodies use.
 * `type:oauth` and `type:api-key` data are closed objects upstream
 * (`additionalProperties: false`), so they are `.strict()` here: a key
 * Connect would reject fails the test instead of the person's first create.
 */
import { type JsonObject, isString } from "@opensesame/os-domain";
import { z } from "zod";

const grant = z
  .object({ enabled: z.boolean(), scopes: z.array(z.string()).optional() })
  .strict();

export const OauthDataSchema = z
  .object({
    authorizationUrlParams: z.record(z.string(), z.string()).optional(),
    clientId: z.string().min(1),
    clientName: z.string().optional(),
    clientSecret: z.string().optional(),
    codeChallengeMethod: z.enum(["S256", "plain", ""]).optional(),
    defaultAudience: z.string().optional(),
    defaultTokenExpiresIn: z.number().min(60).optional(),
    pkceRequired: z.boolean().optional(),
    refreshTokens: z.object({ enabled: z.boolean() }).strict().optional(),
    responseType: z.string().optional(),
    serverConfig: z
      .object({
        authorization_endpoint: z.string().url().optional(),
        token_endpoint: z.string().url().optional(),
        revocation_endpoint: z.string().url().optional(),
        userinfo_endpoint: z.string().url().optional(),
        issuer: z.string().url().optional(),
        code_challenge_methods_supported: z.array(z.string()).optional(),
        scopes_supported: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    serverUrl: z.string().url().optional(),
    tokenEndpointAuthMethod: z.string().optional(),
    userAuthorization: grant.optional(),
    clientCredentials: grant.optional(),
  })
  .strict();

export const ApiKeyDataSchema = z
  .object({
    instructions: z.string().max(4000).optional(),
    serviceUrls: z.array(z.string().url()).min(1).max(8).optional(),
    subjectType: z.enum(["app", "user"]).optional(),
    values: z
      .array(
        z
          .object({
            value: z.string().min(1),
            expiresAt: z.number().int().positive().optional(),
            scope: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const common = {
  name: z.string().min(1).optional(),
  uid: z
    .string()
    .regex(/^[^\s%#]+$/)
    .optional(),
  projectId: z.string().optional(),
  params: z.record(z.string(), z.string().max(256)).optional(),
  target: z.string().max(64).optional(),
};

export const FullConfigurationSchema = z.object({
  ...common,
  service: z.string().min(1).optional(),
  type: z.string().min(1),
  connectionMethod: z.string().max(64).optional(),
  data: z.record(z.string(), z.unknown()),
});

export const PresetConfigurationSchema = z.object({
  ...common,
  service: z.string().min(1),
  connectionMethod: z.string().min(1).max(64),
  type: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

/** Throws with Connect's own words for the first thing it would refuse. */
export function assertConnectAccepts(body: JsonObject): void {
  if (isString(body.type)) {
    FullConfigurationSchema.parse(body);
  } else if (isString(body.connectionMethod)) {
    PresetConfigurationSchema.parse(body);
  } else {
    // Managed: Vercel registers the app; service and name are the request.
    z.object({ service: z.string().min(1), name: z.string().min(1) })
      .passthrough()
      .parse(body);
    return;
  }
  const data = body.data;
  if (body.type === "oauth") OauthDataSchema.parse(data);
  if (body.type === "api-key" || body.connectionMethod === "api-key") {
    ApiKeyDataSchema.parse(data);
    if (!body.name) throw new Error("API key connectors require name");
  }
}
