/** Read actual server metadata before attempting a public browser registration. */
import {
  OAuthClientMetadataSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import {
  NativeMcpAuthError,
  type NativeMcpOAuthTarget,
} from "./native-mcp-oauth-target.js";

const PublicMetadataSchema = OAuthMetadataSchema.strip();
export type NativeMcpAuthorizationMetadata = z.infer<
  typeof PublicMetadataSchema
>;

const CimdDocumentSchema = OAuthClientMetadataSchema.extend({
  client_id: z.string().url(),
  client_name: z.string().min(1),
});

export async function nativeMcpPublicMetadata(
  target: NativeMcpOAuthTarget,
  fetcher: typeof fetch,
): Promise<NativeMcpAuthorizationMetadata> {
  const { metadata, binding } = target;
  if (!metadata.resourceMetadata || !metadata.discoveryUrl)
    throw new NativeMcpAuthError("public-client");
  const resourceResponse = await fetcher(metadata.resourceMetadata);
  if (!resourceResponse.ok) throw new NativeMcpAuthError("metadata");
  const resource = OAuthProtectedResourceMetadataSchema.parse(
    await resourceResponse.json(),
  );
  if (
    resource.resource !== binding.resource ||
    !resource.authorization_servers?.includes(binding.issuer ?? "")
  )
    throw new NativeMcpAuthError("metadata");
  const response = await fetcher(metadata.discoveryUrl);
  if (!response.ok) throw new NativeMcpAuthError("metadata");
  const live = PublicMetadataSchema.parse(await response.json());
  assertLivePublicMetadata(target, live);
  if (target.registration === "cimd")
    await assertCimdDocument(target, live, fetcher);
  return live;
}

function assertLivePublicMetadata(
  target: NativeMcpOAuthTarget,
  live: NativeMcpAuthorizationMetadata,
): void {
  const { binding, metadata } = target;
  if (
    live.issuer !== binding.issuer ||
    live.authorization_endpoint !== metadata.authorizationEndpoint ||
    live.token_endpoint !== metadata.tokenEndpoint
  )
    throw new NativeMcpAuthError("metadata");
  if (
    !live.token_endpoint_auth_methods_supported?.includes("none") ||
    !live.code_challenge_methods_supported?.includes("S256")
  )
    throw new NativeMcpAuthError("public-client");
  if (
    !live.response_types_supported.includes("code") ||
    (live.grant_types_supported &&
      !live.grant_types_supported.includes("authorization_code"))
  )
    throw new NativeMcpAuthError("public-client");
  if (
    target.registration === "dcr" &&
    live.registration_endpoint !== metadata.registrationEndpoint
  )
    throw new NativeMcpAuthError("metadata");
}

async function assertCimdDocument(
  target: NativeMcpOAuthTarget,
  live: NativeMcpAuthorizationMetadata,
  fetcher: typeof fetch,
): Promise<void> {
  if (!live.client_id_metadata_document_supported || !target.clientMetadataUrl)
    throw new NativeMcpAuthError("public-client");
  const documentResponse = await fetcher(target.clientMetadataUrl);
  if (!documentResponse.ok) throw new NativeMcpAuthError("public-client");
  const document = CimdDocumentSchema.parse(await documentResponse.json());
  if (
    document.client_id !== target.clientMetadataUrl ||
    document.token_endpoint_auth_method !== "none" ||
    !document.redirect_uris?.includes(target.redirectUri)
  )
    throw new NativeMcpAuthError("public-client");
}
