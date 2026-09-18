import { OAuthClientResponseSchema } from "@opensesame/contracts";
import {
  type OAuthClientRecord as StoreClientRecord,
  isPublicClient,
} from "@opensesame/oauth-provider";
import type { OAuthClientRecord } from "@opensesame/os-domain";

export function toDomain(client: StoreClientRecord): OAuthClientRecord {
  return {
    id: client.id,
    ownerPrincipalId: client.ownerPrincipalId ?? "",
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    ...(client.metadataUri ? { metadataUri: client.metadataUri } : undefined),
    ...(client.metadataDigest
      ? { metadataDigest: client.metadataDigest }
      : undefined),
    ...(client.jwks ? { jwks: client.jwks } : undefined),
    state: client.state,
    createdAt: client.createdAt ?? client.firstSeenAt ?? new Date(0),
    updatedAt:
      client.updatedAt ??
      client.lastUsedAt ??
      client.createdAt ??
      client.firstSeenAt ??
      new Date(0),
  };
}

export function toStoreRecord(client: OAuthClientRecord): StoreClientRecord {
  return {
    id: client.id,
    ownerPrincipalId: client.ownerPrincipalId,
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    ...(client.metadataUri ? { metadataUri: client.metadataUri } : undefined),
    ...(client.metadataDigest
      ? { metadataDigest: client.metadataDigest }
      : undefined),
    ...(client.jwks ? { jwks: client.jwks } : undefined),
    state: client.state,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

export function confidentialClientCredentialsError(client: {
  grantTypes: readonly string[];
  tokenEndpointAuthMethod: string;
  jwks?: { keys: readonly unknown[] };
}): string | undefined {
  if (!client.grantTypes.includes("client_credentials")) return undefined;
  if (
    isPublicClient({
      grant_types: [...client.grantTypes],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    })
  ) {
    return "public clients cannot use the client_credentials grant";
  }
  if (
    client.tokenEndpointAuthMethod === "private_key_jwt" &&
    (client.jwks?.keys.length ?? 0) === 0
  ) {
    return "private_key_jwt clients must register a public JWKS";
  }
  return undefined;
}

export function toResponse(client: OAuthClientRecord) {
  return OAuthClientResponseSchema.parse({
    id: client.id,
    ownerPrincipalId: client.ownerPrincipalId,
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    redirectUris: client.redirectUris,
    sectorIdentifier: client.sectorIdentifier,
    grantTypes: client.grantTypes,
    responseTypes: client.responseTypes,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    allowedScopes: client.allowedScopes,
    allowedResources: client.allowedResources,
    state: client.state,
    ...(client.jwks ? { jwks: client.jwks } : undefined),
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  });
}
