import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { exactOrigin } from "./transport.js";

export type LocalAuthorizationRequest = {
  applicationId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  agent?: { principalId: string; keyId: string };
};

const FIELDS = [
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
];
const AGENT_FIELDS = ["agent_id", "agent_key_id"];

function parameter(params: URLSearchParams, name: string): string {
  return params.get(name) ?? "";
}

/** Browser-channel profile, not an HTTP OAuth authorization endpoint. */
export function parseLocalAuthorizationRequest(
  search: string,
): LocalAuthorizationRequest {
  if (search.length > 8192) throw new Error("invalid_request");
  const params = new URLSearchParams(search);
  if (
    [...params.keys()].some(
      (key) => ![...FIELDS, ...AGENT_FIELDS].includes(key),
    ) ||
    FIELDS.some((key) => params.getAll(key).length !== 1)
  )
    throw new Error("invalid_request");
  const applicationId = parameter(params, "client_id");
  const redirectUri = parameter(params, "redirect_uri");
  const scopes = parameter(params, "scope").split(" ");
  const state = parameter(params, "state");
  const nonce = parameter(params, "nonce");
  const codeChallenge = parameter(params, "code_challenge");
  if (
    !/^local_[0-9a-f-]{36}$/.test(applicationId) ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(state) ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
    params.get("code_challenge_method") !== "S256"
  )
    throw new Error("invalid_request");
  validateRedirectAndScopes(redirectUri, scopes);
  const request: LocalAuthorizationRequest = {
    applicationId,
    redirectUri,
    scopes,
    state,
    nonce,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
  const agent = readAgent(params);
  if (agent) request.agent = agent;
  return request;
}

function readAgent(params: URLSearchParams) {
  if (AGENT_FIELDS.some((field) => params.has(field))) {
    const principalId = parameter(params, "agent_id");
    const keyId = parameter(params, "agent_key_id");
    if (
      AGENT_FIELDS.some((field) => params.getAll(field).length !== 1) ||
      !/^local_[0-9a-f-]{36}$/.test(principalId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(keyId)
    )
      throw new Error("invalid_request");
    return { principalId, keyId };
  }
  return undefined;
}

function validateRedirectAndScopes(redirectUri: string, scopes: string[]) {
  const url = new URL(redirectUri);
  exactOrigin(url.origin);
  if (
    redirectUri.length > 2048 ||
    url.href !== redirectUri ||
    url.username ||
    url.password ||
    redirectUri.includes("#") ||
    redirectUri.includes("*") ||
    scopes.length > 32 ||
    !scopes.includes("openid") ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every((scope) => /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(scope))
  )
    throw new Error("invalid_request");
}

export function localAuthorizationQuery(
  request: LocalAuthorizationRequest,
): string {
  const params = new URLSearchParams({
    client_id: request.applicationId,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
  });
  if (request.agent) {
    params.set("agent_id", request.agent.principalId);
    params.set("agent_key_id", request.agent.keyId);
  }
  return params.toString();
}

/** Small flat channel envelopes only; reject objects before any serialization. */
export function localMessage(value: BoundaryValue, state: string) {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length > 10 ||
    value.state !== state ||
    !Object.values(value).every(
      (field) => isString(field) && field.length <= 2048,
    )
  )
    return null;
  return value;
}
