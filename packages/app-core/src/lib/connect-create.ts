/**
 * Connector plan + what a person typed → the Vercel Connect request bodies
 * (ADR 0146). A connector created with a bare `{ service, name }` has no
 * OAuth server, no client and no scopes — Connect applies a preset only when
 * `connectionMethod` names one — so every body here carries the whole
 * configuration: the standard OAuth authorization-code settings for a
 * generic API integration, filled from what we know about the service.
 */
import type { JsonObject } from "@opensesame/os-domain";
import {
  type ConnectPlan,
  type OauthPreset,
  defaultScopes,
  fillTemplate,
  hasOpenTemplate,
} from "./connect-plan.js";

export type TokenAuth = OauthPreset["tokenAuth"];
export type Pkce = OauthPreset["pkce"];

/** Every OAuth field the connector page shows, editable. */
export type OauthDraft = {
  serverUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  userinfoEndpoint: string;
  tokenAuth: TokenAuth;
  pkce: Pkce;
  authorizationParams: Record<string, string>;
  scopes: string[];
  refreshTokens: boolean;
  clientId: string;
  clientSecret: string;
  /**
   * How the client comes to exist. `manual`: the person registers an app and
   * pastes its credentials. `dcr` / `cimd`: the server registers the client
   * itself, so a blank client ID asks Vercel to do it (assisted setup).
   */
  registration: OauthPreset["registration"];
};

export type ConnectorDraft = { name: string; uid: string } & (
  | { kind: "managed" }
  | { kind: "oauth"; oauth: OauthDraft }
  | {
      kind: "mcp";
      clientId: string;
      clientSecret: string;
      /** `manual`: the MCP server registers no clients; paste one. */
      registration: OauthPreset["registration"];
    }
  | {
      kind: "api-key";
      /** `user`: each person pastes their own key while authorizing. */
      subject: "user" | "app";
      key: string;
      serviceUrls: string[];
      instructions: string;
    }
);

/** A draft filled from a preset, templates resolved from `params`. */
export function oauthDraftFrom(
  preset: OauthPreset,
  params: Readonly<Record<string, string>> = {},
): OauthDraft {
  const fill = (value: string | null) =>
    value ? fillTemplate(value, params) : "";
  return {
    serverUrl: fill(preset.serverUrl),
    authorizationEndpoint: fill(preset.authorizationEndpoint),
    tokenEndpoint: fill(preset.tokenEndpoint),
    revocationEndpoint: fill(preset.revocationEndpoint),
    userinfoEndpoint: fill(preset.userinfoEndpoint),
    tokenAuth: preset.tokenAuth,
    pkce: preset.pkce,
    authorizationParams: Object.fromEntries(
      Object.entries(preset.authorizationParams).map(([key, value]) => [
        key,
        fillTemplate(value, params),
      ]),
    ),
    scopes: defaultScopes(preset),
    refreshTokens: preset.refreshTokens,
    clientId: "",
    clientSecret: "",
    registration: preset.registration,
  };
}

/** A blank client ID on a self-registering server: Vercel registers it. */
export function assistedRegistration(o: OauthDraft): boolean {
  return o.registration !== "manual" && !o.clientId.trim();
}

/** A connector UID Connect accepts: `<service>/<slug>`. */
export function suggestUid(plan: ConnectPlan, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${plan.id}/${slug || "default"}`;
}

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function urlProblems(
  fields: readonly (readonly [string, string])[],
  required: boolean,
): string[] {
  const problems: string[] = [];
  for (const [label, value] of fields) {
    if (!required && !value) continue;
    if (hasOpenTemplate(value)) problems.push(`${label} needs your domain.`);
    else if (!httpsUrl(value)) problems.push(`${label} must be https.`);
  }
  return problems;
}

function oauthProblems(o: OauthDraft): string[] {
  const problems = [
    ...urlProblems(
      [
        ["Server URL", o.serverUrl],
        ["Authorization endpoint", o.authorizationEndpoint],
        ["Token endpoint", o.tokenEndpoint],
      ],
      true,
    ),
    ...urlProblems(
      [
        ["Revocation endpoint", o.revocationEndpoint],
        ["User info endpoint", o.userinfoEndpoint],
      ],
      false,
    ),
  ];
  if (assistedRegistration(o)) return problems;
  if (!o.clientId.trim()) problems.push("Paste the client ID.");
  if (o.tokenAuth !== "none" && !o.clientSecret.trim()) {
    problems.push("Paste the client secret.");
  }
  return problems;
}

function methodProblems(draft: ConnectorDraft): string[] {
  if (draft.kind === "oauth") return oauthProblems(draft.oauth);
  if (draft.kind === "mcp") {
    return draft.registration === "manual" && !draft.clientId.trim()
      ? ["Paste the client ID."]
      : [];
  }
  if (draft.kind !== "api-key") return [];
  const problems: string[] = [];
  if (draft.subject === "app" && !draft.key.trim()) {
    problems.push("Paste the API key.");
  }
  if (!draft.serviceUrls.some(httpsUrl)) {
    problems.push("Name the https API the key is for.");
  }
  return problems;
}

/** Why a draft cannot be created yet; empty when it can. */
export function draftProblems(draft: ConnectorDraft): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push("Name the connector.");
  if (draft.uid && !/^[^\s%#]+\/[^\s%#]+$/.test(draft.uid)) {
    problems.push("A UID looks like service/name, with no spaces.");
  }
  return [...problems, ...methodProblems(draft)];
}

function oauthData(o: OauthDraft, withSecret: boolean): JsonObject {
  const serverConfig: JsonObject = {
    authorization_endpoint: o.authorizationEndpoint.trim(),
    token_endpoint: o.tokenEndpoint.trim(),
  };
  if (o.revocationEndpoint.trim()) {
    serverConfig.revocation_endpoint = o.revocationEndpoint.trim();
  }
  if (o.userinfoEndpoint.trim()) {
    serverConfig.userinfo_endpoint = o.userinfoEndpoint.trim();
  }
  if (o.pkce !== "none")
    serverConfig.code_challenge_methods_supported = ["S256"];
  const data: JsonObject = {
    clientId: o.clientId.trim(),
    serverUrl: o.serverUrl.trim(),
    serverConfig,
    tokenEndpointAuthMethod: o.tokenAuth,
    userAuthorization: { enabled: true, scopes: o.scopes },
    refreshTokens: { enabled: o.refreshTokens },
  };
  if (withSecret && o.clientSecret.trim()) {
    data.clientSecret = o.clientSecret.trim();
  }
  if (o.pkce !== "none") data.codeChallengeMethod = "S256";
  if (o.pkce === "required") data.pkceRequired = true;
  const params = Object.entries(o.authorizationParams).filter(
    ([key, value]) => key.trim() && value.trim(),
  );
  if (params.length > 0) {
    data.authorizationUrlParams = Object.fromEntries(
      params.map(([key, value]) => [key.trim(), value.trim()]),
    );
  }
  return data;
}

function apiKeyData(
  draft: Extract<ConnectorDraft, { kind: "api-key" }>,
): JsonObject {
  const data: JsonObject = {
    serviceUrls: draft.serviceUrls.filter(httpsUrl).slice(0, 8),
    subjectType: draft.subject,
  };
  if (draft.instructions.trim()) {
    data.instructions = draft.instructions.trim().slice(0, 4000);
  }
  if (draft.subject === "app" && draft.key.trim()) {
    data.values = [{ value: draft.key.trim() }];
  }
  return data;
}

function registryMethod(plan: ConnectPlan, kind: "mcp" | "api-key"): boolean {
  return plan.registry && plan.methods.some((method) => method.kind === kind);
}

/** `POST /v1/connect/connectors` — the whole configuration, never a bare service. */
export function createBody(
  plan: ConnectPlan,
  draft: ConnectorDraft,
): JsonObject {
  const base: JsonObject = { name: draft.name.trim() };
  if (draft.uid.trim()) base.uid = draft.uid.trim();
  switch (draft.kind) {
    case "managed":
      return { ...base, service: plan.id };
    case "oauth":
      if (plan.registry && assistedRegistration(draft.oauth)) {
        return {
          ...base,
          service: plan.id,
          connectionMethod: "oauth",
          data: {},
        };
      }
      return {
        ...base,
        service: plan.registry ? plan.id : new URL(draft.oauth.serverUrl).host,
        type: "oauth",
        data: oauthData(draft.oauth, true),
      };
    case "mcp": {
      const data: JsonObject = {};
      if (draft.clientId.trim()) data.clientId = draft.clientId.trim();
      if (draft.clientSecret.trim()) {
        data.clientSecret = draft.clientSecret.trim();
      }
      return { ...base, service: plan.id, connectionMethod: "mcp", data };
    }
    case "api-key":
      return registryMethod(plan, "api-key")
        ? {
            ...base,
            service: plan.id,
            connectionMethod: "api-key",
            data: apiKeyData(draft),
          }
        : {
            ...base,
            service: plan.id,
            type: "api-key",
            data: apiKeyData(draft),
          };
  }
}

/**
 * `PATCH /v1/connect/connectors/{id}`. A blank secret keeps the stored one:
 * Connect never returns a secret, so the page never has it to resend.
 */
export function updateBody(draft: ConnectorDraft): JsonObject {
  const body: JsonObject = { name: draft.name.trim() };
  if (draft.kind === "oauth") body.data = oauthData(draft.oauth, true);
  if (draft.kind === "api-key") {
    const data: JsonObject = {};
    if (draft.instructions.trim())
      data.instructions = draft.instructions.trim();
    if (draft.subject === "app" && draft.key.trim()) {
      data.toAdd = [{ value: draft.key.trim() }];
    }
    body.data = data;
  }
  return body;
}

export type ConnectSubject = { type: "user"; id: string } | { type: "app" };

/** `POST /v1/connect/authorize/{id}` — on behalf of a person by default. */
export function authorizeBody(
  subject: ConnectSubject,
  scopes: readonly string[],
  returnUrl?: string,
): JsonObject {
  const body: JsonObject = {
    subject:
      subject.type === "user"
        ? { type: "user", id: subject.id }
        : { type: "app" },
  };
  if (scopes.length > 0) body.scopes = [...scopes];
  if (returnUrl) body.returnUrl = returnUrl;
  return body;
}
