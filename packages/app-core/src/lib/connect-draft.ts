import { type WebStorage, maybeLocalStore } from "../ports.js";
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

const TEMPLATED_OAUTH = [
  "serverUrl",
  "authorizationEndpoint",
  "tokenEndpoint",
  "revocationEndpoint",
  "userinfoEndpoint",
] as const;

/** Re-fill `next` where `current` still holds what `previous` filled in. */
function refill<T>(current: T, previous: T, next: T): T {
  return JSON.stringify(current) === JSON.stringify(previous) ? next : current;
}

/**
 * Fill a placeholder and re-derive every field that used it — only where the
 * field still holds the preset's fill. A field the person edited by hand is
 * theirs, and a placeholder never overwrites it.
 */
export function withParam(
  state: DraftState,
  plan: ConnectPlan,
  name: string,
  value: string,
): DraftState {
  const params = { ...state.params, [name]: value };
  const previous = oauthFor(plan, state.params);
  const refreshed = oauthFor(plan, params);
  const oauth: OauthDraft = { ...state.oauth };
  for (const field of TEMPLATED_OAUTH) {
    oauth[field] = refill(
      state.oauth[field],
      previous[field],
      refreshed[field],
    );
  }
  oauth.authorizationParams = refill(
    state.oauth.authorizationParams,
    previous.authorizationParams,
    refreshed.authorizationParams,
  );
  const keyUrls = apiKeyFor(plan).serviceUrls;
  return {
    ...state,
    params,
    serviceUrls: keyUrls.some((url) => url.includes("{"))
      ? refill(
          state.serviceUrls,
          keyUrls.map((url) => fillTemplate(url, state.params)),
          keyUrls.map((url) => fillTemplate(url, params)),
        )
      : state.serviceUrls,
    oauth,
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
      pkce: detail.pkce ?? base.oauth.pkce,
      authorizationParams:
        Object.keys(detail.authorizationParams).length > 0
          ? detail.authorizationParams
          : base.oauth.authorizationParams,
      scopes: detail.scopes.length > 0 ? detail.scopes : base.oauth.scopes,
      refreshTokens: detail.refreshTokens ?? base.oauth.refreshTokens,
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

const SUBJECT_PREFIX = "opensesame.connect-subject.";
const LOCAL_SUBJECT = /^local-[0-9a-f]{32}$/;

function randomLocalSubject(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `local-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The subject id Connect keys a person's tokens by: their principal when
 * signed in, else a random id this device keeps for the vault. A vault's
 * name is not an identity (every device's personal vault shares one), so it
 * never becomes the subject — two people must never share a token.
 */
export function connectSubjectId(
  principalId: string | null | undefined,
  tomb: string | null | undefined,
  store: WebStorage | undefined = maybeLocalStore(),
): string | null {
  const id = principalId?.trim();
  if (id && /^[A-Za-z0-9_.:@-]{1,128}$/.test(id)) return id;
  const vault = tomb?.trim();
  if (!vault || !store) return null;
  const key = `${SUBJECT_PREFIX}${vault}`;
  try {
    const kept = store.getItem(key);
    if (kept && LOCAL_SUBJECT.test(kept)) return kept;
    const fresh = randomLocalSubject();
    store.setItem(key, fresh);
    return store.getItem(key) === fresh ? fresh : null;
  } catch {
    return null;
  }
}
