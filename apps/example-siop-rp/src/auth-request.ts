import {
  type NormalizedAuthorizationRequest,
  RESPONSE_MODE_FRAGMENT,
  RESPONSE_TYPE_ID_TOKEN,
  SCOPE_OPENID,
  serializeAuthorizationRequest,
} from "@opensesame/siop-v2";
import { type SiopRpConfig, dynamicSiopIssuer } from "./config.js";

function normalizedRequest(
  config: SiopRpConfig,
  input: { nonce: string; state: string },
): NormalizedAuthorizationRequest {
  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    nonce: input.nonce,
    state: input.state,
    scope: SCOPE_OPENID,
    responseType: RESPONSE_TYPE_ID_TOKEN,
    responseMode: RESPONSE_MODE_FRAGMENT,
  };
}

/** Authorization request for OpenSesame Pages Self-Issued OP (draft-07). */
export function buildSiopAuthorizationUrl(
  config: SiopRpConfig,
  input: { nonce: string; state: string },
): string {
  const endpoint = dynamicSiopIssuer(config.pagesBase);
  const query = serializeAuthorizationRequest(normalizedRequest(config, input));
  return `${endpoint}?${query}`;
}
