/** Validated editable records; secrets are removed before any public row is built. */
import { z } from "zod";
import type { DraftState } from "./connect-draft.js";

function validIcon(value: string): boolean {
  if (value === "") return true;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    value,
  );
  if (!match) return false;
  const body = match[2];
  if (!body || body.length % 4 !== 0) return false;
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return (
    (body.length * 3) / 4 - padding <= 2 * 1024 * 1024 &&
    (match[1] === "png"
      ? body.startsWith("iVBORw0KGgo")
      : body.startsWith("/9j/"))
  );
}

const strings = z.array(z.string());
const stringMap = z.record(z.string(), z.string());
export const OptionsSchema = z.object({
  mode: z.enum(["managed", "byo"]),
  workspace: z.string(),
  appScopes: strings,
  userScopes: strings,
  webhookResourceTypes: strings,
  webhookEnabled: z.boolean().optional(),
  webhookUrl: z.string().optional(),
  icon: z.string().refine(validIcon, "Use a PNG or JPEG icon under 2 MB"),
});

export type SelfHostedConnectorOptions = z.infer<typeof OptionsSchema>;

export const DraftSchema: z.ZodType<DraftState> = z.object({
  method: z.enum(["managed", "oauth", "mcp", "api-key"]),
  name: z.string(),
  uid: z.string(),
  params: stringMap,
  oauth: z.object({
    serverUrl: z.string(),
    authorizationEndpoint: z.string(),
    tokenEndpoint: z.string(),
    revocationEndpoint: z.string(),
    userinfoEndpoint: z.string(),
    tokenAuth: z.enum(["client_secret_post", "client_secret_basic", "none"]),
    pkce: z.enum(["S256", "none", "required"]),
    authorizationParams: stringMap,
    scopes: strings,
    refreshTokens: z.boolean(),
    clientId: z.string(),
    clientSecret: z.string(),
    registration: z.enum(["manual", "dcr", "cimd"]),
  }),
  mcpClientId: z.string(),
  mcpClientSecret: z.string(),
  mcpRegistration: z.enum(["manual", "dcr", "cimd"]),
  keySubject: z.enum(["user", "app"]),
  key: z.string(),
  serviceUrls: strings,
  instructions: z.string(),
});

export const SavedSchema = z.object({
  state: DraftSchema,
  options: OptionsSchema,
});
