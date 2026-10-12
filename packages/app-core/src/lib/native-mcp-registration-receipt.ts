/** RFC7592 management authority is private and bound to the actual DCR response. */
import {
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { nativeMcpUrl } from "./native-mcp-target.js";

export const NativeMcpRegistrationReceiptSchema =
  OAuthClientInformationSchema.extend({
    token_endpoint_auth_method: z.string().optional(),
    registration_access_token: z
      .string()
      .min(1)
      .max(32768)
      .regex(/^[!-~]+$/)
      .optional(),
    registration_client_uri: z.string().url().optional(),
  });
export type NativeMcpRegisteredClient = OAuthClientInformationMixed & {
  registration_access_token?: string;
  registration_client_uri?: string;
};

export function nativeMcpRegistrationManagementUrl(
  target: NativeMcpOAuthTarget,
  client: NativeMcpRegisteredClient,
): URL {
  if (
    target.registration !== "dcr" ||
    !target.metadata.registrationEndpoint ||
    !client.registration_client_uri ||
    !client.registration_access_token
  )
    throw new NativeMcpAuthError("public-client");
  const base = nativeMcpUrl(target.metadata.registrationEndpoint);
  const management = nativeMcpUrl(client.registration_client_uri);
  const prefix = base.pathname.replace(/\/$/, "");
  if (
    management.origin !== base.origin ||
    !management.pathname.startsWith(`${prefix}/`)
  )
    throw new NativeMcpAuthError("metadata");
  return management;
}
