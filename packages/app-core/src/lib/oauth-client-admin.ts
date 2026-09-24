/**
 * The Identity API's hosted applications, edited from the Applications tab:
 * rename, redirect URIs and scopes, and the claims a sign-in would release.
 * Operator identity providers own these calls (always on, ADR 0142), so the
 * always-on Identity section reaches them without carrying the directory's
 * people and agents (`identity-management.ts`).
 */

import { type JsonObject, isJsonObject } from "@opensesame/os-domain";
import { call } from "./directory.js";

type ApplicationUpdateExtras = {
  allowedScopes?: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
};

export function updateApplication(
  id: string,
  displayName: string,
  redirectUris: string[],
  extras: ApplicationUpdateExtras = {},
) {
  return call(
    `/v1/oauth/clients/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        displayName,
        redirectUris,
        ...extras,
      }),
    },
    () => undefined,
  );
}

type HostedClaimsPreviewInput = {
  scopes: string[];
  persona: JsonObject;
};

export function previewHostedClaims(
  id: string,
  input: HostedClaimsPreviewInput,
) {
  return call(
    `/v1/oauth/clients/${encodeURIComponent(id)}/claim-preview`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
    (body) => (isJsonObject(body) ? body : {}),
  );
}
