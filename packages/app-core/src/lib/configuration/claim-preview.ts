import type { JsonObject } from "@opensesame/os-domain";
/** Unsigned synthetic claim preview. Never a token. */

export type SyntheticPersona = {
  name?: string;
  email?: string;
  emailVerified?: boolean;
  emailAuthoritative?: boolean;
  groups?: readonly string[];
  orgId?: string;
};

export type ClaimPreview = {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  groups?: readonly string[];
  omitted: readonly string[];
};

const RESERVED = new Set([
  "sub",
  "iss",
  "aud",
  "exp",
  "iat",
  "nbf",
  "jti",
  "azp",
]);

export function previewSyntheticClaims(input: {
  pairwiseSub: string;
  scopes: readonly string[];
  persona: SyntheticPersona;
  mappingOrgId?: string;
}): ClaimPreview {
  const omitted: string[] = [];
  const preview: ClaimPreview = { sub: input.pairwiseSub, omitted };
  if (input.scopes.includes("profile") && input.persona.name) {
    preview.name = input.persona.name;
  } else {
    omitted.push("name");
  }
  const emailOk =
    input.scopes.includes("email") &&
    input.persona.email &&
    input.persona.emailVerified === true &&
    input.persona.emailAuthoritative !== false;
  if (emailOk) {
    preview.email = input.persona.email;
    preview.email_verified = true;
  } else {
    omitted.push("email");
  }
  const groupsOk =
    input.mappingOrgId &&
    input.persona.orgId === input.mappingOrgId &&
    input.persona.groups;
  if (groupsOk) preview.groups = input.persona.groups;
  else omitted.push("groups");
  return preview;
}

export function mappingOverridesReserved(mapping: JsonObject): boolean {
  return Object.keys(mapping).some((key) => RESERVED.has(key));
}
