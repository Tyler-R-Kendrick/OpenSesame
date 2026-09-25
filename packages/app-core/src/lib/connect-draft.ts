/**
 * The connector page's form state (ADR 0146): which method, what the person
 * typed, and the OAuth fields a preset filled in — one plain record the page
 * renders and `toConnectorDraft` turns into a create or update.
 */
import {
  type ConnectorDraft,
  type OauthDraft,
  oauthDraftFrom,
  suggestUid,
} from "./connect-create.js";
import {
  type ConnectMethod,
  type ConnectMethodKind,
  type ConnectPlan,
  fillTemplate,
  preferredMethod,
} from "./connect-plan.js";
import type { ConnectorDetail } from "./vercel-connect-manage.js";

/** Values a person typed for a preset's `{placeholders}`, by name. */
export type TemplateValues = Record<string, string>;

/** A scope a person can tick: its name and the preset's words for it. */
export type ScopeChoice = { name: string; description: string };

export type DraftState = {
  method: ConnectMethodKind;
  name: string;
  uid: string;
  /** Values for a preset's `{placeholders}` — an Okta domain, a shop. */
  params: TemplateValues;
  oauth: OauthDraft;
  mcpClientId: string;
  mcpClientSecret: string;
  mcpRegistration: "manual" | "dcr" | "cimd";
  keySubject: "user" | "app";
  key: string;
  serviceUrls: string[];
  instructions: string;
};

const BLANK_OAUTH: OauthDraft = {
  serverUrl: "",
  authorizationEndpoint: "",
  tokenEndpoint: "",
  revocationEndpoint: "",
  userinfoEndpoint: "",
  tokenAuth: "client_secret_post",
  pkce: "S256",
  authorizationParams: {},
  scopes: [],
  refreshTokens: true,
  clientId: "",
  clientSecret: "",
  registration: "manual",
};

export function methodOf(
  plan: ConnectPlan,
  kind: ConnectMethodKind,
): ConnectMethod | undefined {
  return plan.methods.find((method) => method.kind === kind);
}

function oauthFor(plan: ConnectPlan, params: DraftState["params"]): OauthDraft {
  const method = methodOf(plan, "oauth");
  return method?.kind === "oauth" && method.preset
    ? oauthDraftFrom(method.preset, params)
    : { ...BLANK_OAUTH, authorizationParams: {} };
}

function apiKeyFor(
  plan: ConnectPlan,
): Pick<DraftState, "serviceUrls" | "instructions"> {
  const method = methodOf(plan, "api-key");
  if (method?.kind !== "api-key") {
    const mcp = methodOf(plan, "mcp");
    return {
      serviceUrls: mcp?.kind === "mcp" ? [mcp.mcp.url] : [],
      instructions: "",
    };
  }
  const templated = (method.preset?.templateParams.length ?? 0) > 0;
  return {
    serviceUrls:
      templated || method.urls.length === 0
        ? (method.preset?.serviceUrls ?? method.urls)
        : method.urls,
    instructions: method.preset?.instructions ?? "",
  };
}

function mcpRegistrationOf(plan: ConnectPlan): DraftState["mcpRegistration"] {
  const mcp = methodOf(plan, "mcp");
  return mcp?.kind === "mcp" && mcp.mcp.status === "ok"
    ? mcp.mcp.registration
    : "manual";
}

/** A fresh form for a plan, on the method that asks the least. */
export function initialDraftState(
  plan: ConnectPlan,
  kind?: ConnectMethodKind,
): DraftState {
  const method = kind ?? preferredMethod(plan)?.kind ?? "oauth";
  const name = plan.name;
  return {
    method,
    name,
    uid: suggestUid(plan, "default"),
    params: {},
    oauth: oauthFor(plan, {}),
    mcpClientId: "",
    mcpClientSecret: "",
    mcpRegistration: mcpRegistrationOf(plan),
    keySubject: "user",
    key: "",
    ...apiKeyFor(plan),
  };
}

/** Fill a placeholder and re-derive every endpoint that used it. */
export function withParam(
  state: DraftState,
  plan: ConnectPlan,
  name: string,
  value: string,
): DraftState {
  const params = { ...state.params, [name]: value };
  const refreshed = oauthFor(plan, params);
  const keyUrls = apiKeyFor(plan).serviceUrls;
  return {
    ...state,
    params,
    serviceUrls: keyUrls.some((url) => url.includes("{"))
      ? keyUrls.map((url) => fillTemplate(url, params))
      : state.serviceUrls,
    oauth: {
      ...refreshed,
      scopes: state.oauth.scopes,
      clientId: state.oauth.clientId,
      clientSecret: state.oauth.clientSecret,
      tokenAuth: state.oauth.tokenAuth,
      pkce: state.oauth.pkce,
      refreshTokens: state.oauth.refreshTokens,
      registration: state.oauth.registration,
    },
  };
}

/** The settings form for a connector that exists, from what Connect holds. */
export function draftStateFromDetail(
  plan: ConnectPlan,
  detail: ConnectorDetail,
): DraftState {
  const base = initialDraftState(plan);
  const method: ConnectMethodKind =
    detail.type === "api-key"
      ? "api-key"
      : detail.type === "oauth"
        ? "oauth"
        : base.method;
  const pick = (held: string, fallback: string) => held || fallback;
  return {
    ...base,
    method,
    name: detail.name || base.name,
    uid: detail.uid || base.uid,
    oauth: {
      serverUrl: pick(detail.serverUrl, base.oauth.serverUrl),
      authorizationEndpoint: pick(
        detail.authorizationEndpoint,
        base.oauth.authorizationEndpoint,
      ),
      tokenEndpoint: pick(detail.tokenEndpoint, base.oauth.tokenEndpoint),
      revocationEndpoint: pick(
        detail.revocationEndpoint,
        base.oauth.revocationEndpoint,
      ),
      userinfoEndpoint: pick(
        detail.userinfoEndpoint,
        base.oauth.userinfoEndpoint,
      ),
      tokenAuth:
        detail.tokenAuth === "client_secret_basic" ||
        detail.tokenAuth === "client_secret_post" ||
        detail.tokenAuth === "none"
          ? detail.tokenAuth
          : base.oauth.tokenAuth,
      pkce: detail.type === "oauth" ? detail.pkce : base.oauth.pkce,
      authorizationParams:
        Object.keys(detail.authorizationParams).length > 0
          ? detail.authorizationParams
          : base.oauth.authorizationParams,
      scopes: detail.scopes.length > 0 ? detail.scopes : base.oauth.scopes,
      refreshTokens:
        detail.type === "oauth"
          ? detail.refreshTokens
          : base.oauth.refreshTokens,
      clientId: detail.clientId,
      clientSecret: "",
      registration: base.oauth.registration,
    },
    keySubject: detail.subjectType === "app" ? "app" : "user",
    serviceUrls:
      detail.serviceUrls.length > 0 ? detail.serviceUrls : base.serviceUrls,
    instructions: detail.instructions || base.instructions,
  };
}

export function toConnectorDraft(state: DraftState): ConnectorDraft {
  const common = { name: state.name, uid: state.uid };
  switch (state.method) {
    case "managed":
      return { ...common, kind: "managed" };
    case "oauth":
      return { ...common, kind: "oauth", oauth: state.oauth };
    case "mcp":
      return {
        ...common,
        kind: "mcp",
        clientId: state.mcpClientId,
        clientSecret: state.mcpClientSecret,
        registration: state.mcpRegistration,
      };
    case "api-key":
      return {
        ...common,
        kind: "api-key",
        subject: state.keySubject,
        key: state.key,
        serviceUrls: state.serviceUrls,
        instructions: state.instructions,
      };
  }
}

/** Scopes a person can pick from: the preset's, then any they added. */
export function scopeChoices(
  plan: ConnectPlan,
  state: DraftState,
): ScopeChoice[] {
  const method = methodOf(plan, "oauth");
  const known =
    method?.kind === "oauth" && method.preset ? method.preset.scopes : [];
  const extra = state.oauth.scopes
    .filter((name) => !known.some((scope) => scope.name === name))
    .map((name) => ({ name, description: "" }));
  return [
    ...known.map(({ name, description }) => ({ name, description })),
    ...extra,
  ];
}

export function toggleScope(state: DraftState, scope: string): DraftState {
  const has = state.oauth.scopes.includes(scope);
  return {
    ...state,
    oauth: {
      ...state.oauth,
      scopes: has
        ? state.oauth.scopes.filter((name) => name !== scope)
        : [...state.oauth.scopes, scope],
    },
  };
}

/** The subject id Connect keys a person's tokens by. */
export function connectSubjectId(
  principalId: string | null | undefined,
  tomb: string | null | undefined,
): string | null {
  const id = principalId?.trim();
  if (id && /^[A-Za-z0-9_.:@-]{1,128}$/.test(id)) return id;
  const local = tomb
    ?.trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 48);
  return local ? `local-${local}` : null;
}
