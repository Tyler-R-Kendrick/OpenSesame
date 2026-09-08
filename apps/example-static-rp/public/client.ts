import {
  defaultOriginCallback,
  originProfileClientId,
} from "@opensesame/sdk-browser";
import { createHostedClient } from "@opensesame/static-auth";

declare const __OPENSESAME_ISSUER__: string;

export const issuer = __OPENSESAME_ISSUER__;
export const origin = window.location.origin;
export const sesame = createHostedClient({
  profile: "hosted_identity",
  issuer,
  clientId: originProfileClientId(origin),
  redirectUri: defaultOriginCallback(origin),
  authorizationEndpoint: `${issuer}/auth`,
  tokenEndpoint: `${issuer}/token`,
  jwksUri: `${issuer}/jwks`,
});

export function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing example UI element");
  return node;
}
