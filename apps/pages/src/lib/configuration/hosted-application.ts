import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { OAuthClient } from "../directory.js";
import type { ConfigDiagnostic } from "./types.js";
import { parseConfigYaml } from "./yaml-profile.js";

export type HostedApplicationDraft = {
  id: string;
  displayName: string;
  redirectUris: string[];
  allowedScopes: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
};

export function hostedClientToYaml(client: OAuthClient): string {
  const redirects = client.redirectUris.map((uri) => `  - ${uri}`).join("\n");
  const scopes = (
    client.allowedScopes.length ? client.allowedScopes : ["openid"]
  )
    .map((scope) => `  - ${scope}`)
    .join("\n");
  const grants = (
    client.grantTypes?.length ? client.grantTypes : ["authorization_code"]
  )
    .map((grant) => `  - ${grant}`)
    .join("\n");
  return `# Hosted OIDC client. Registration is not consent.
id: ${client.id}
displayName: ${client.displayName}
tokenEndpointAuthMethod: ${client.tokenEndpointAuthMethod}
redirectUris:
${redirects}
allowedScopes:
${scopes}
grantTypes:
${grants}
`;
}

function stringList(value: BoundaryValue): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (!isString(item)) return undefined;
    strings.push(item);
  }
  return strings.filter((item) => item.length > 0);
}

/** ADV-32: a draft bound to one issuer cannot auto-apply to another. */
export function hostedDraftMatchesIssuer(
  boundIssuer: string,
  currentIssuer: string,
): boolean {
  return boundIssuer === currentIssuer && boundIssuer.length > 0;
}

export function parseHostedApplicationSource(
  source: string,
  clientId: string,
):
  | { ok: true; value: HostedApplicationDraft }
  | { ok: false; diagnostics: ConfigDiagnostic[] } {
  const parsed = parseConfigYaml(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const displayName: BoundaryValue = overlapCast(parsed.value.displayName);
  const redirectUris = stringList(overlapCast(parsed.value.redirectUris));
  const allowedScopes =
    stringList(overlapCast(parsed.value.allowedScopes)) ?? ["openid"];
  const grantTypes = stringList(overlapCast(parsed.value.grantTypes)) ?? [
    "authorization_code",
  ];
  const tokenMethod: BoundaryValue = overlapCast(
    parsed.value.tokenEndpointAuthMethod,
  );
  const tokenEndpointAuthMethod = isString(tokenMethod)
    ? tokenMethod
    : "none";
  if (!isString(displayName) || !redirectUris) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "shape",
          message: "Source must name displayName and redirectUris.",
        },
      ],
    };
  }
  const idField: BoundaryValue = overlapCast(parsed.value.id);
  if (isString(idField) && idField !== clientId) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "identity",
          message: "id cannot be changed in source.",
        },
      ],
    };
  }
  if (parsed.value.ownerPrincipalId !== undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          code: "owner",
          message: "ownerPrincipalId cannot be set through source.",
        },
      ],
    };
  }
  return {
    ok: true,
    value: {
      id: clientId,
      displayName,
      redirectUris,
      allowedScopes,
      grantTypes,
      tokenEndpointAuthMethod,
    },
  };
}
