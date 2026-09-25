/**
 * What a person types for each connector, and the provider its preset
 * describes (ADR 0146 conformance): the draft the page would submit, and the
 * profile the provider emulator enforces.
 */
import {
  type DraftState,
  initialDraftState,
  withParam,
} from "@opensesame/app-core/lib/connect-draft.js";
import {
  type ApiKeyPreset,
  type ConnectMethodKind,
  type ConnectPlan,
  type McpInfo,
  type OauthPreset,
  fillTemplate,
} from "@opensesame/app-core/lib/connect-plan.js";
import type { ProviderProfile } from "./provider-emulator.js";

export const PARAM = "acme.example";

type Scenario = { profile: ProviderProfile; state: DraftState };
type Verify = NonNullable<OauthPreset["verify"]>;

const BASE = { registerPath: "/register", cimd: false, requiredParams: {} };

const path = (url: string) => new URL(url).pathname;

/** Every placeholder filled with the test value; `{key}` stays. */
export const fill = (url: string) =>
  fillTemplate(
    url,
    new Proxy({}, { get: (_t, name) => (name === "key" ? undefined : PARAM) }),
  );

function filledHeaders(verify: Verify): Record<string, string> {
  return Object.fromEntries(
    Object.entries(verify.headers).map(([k, v]) => [k, fill(v)]),
  );
}

function withParams(plan: ConnectPlan, kind: ConnectMethodKind): DraftState {
  const method = plan.methods.find((m) => m.kind === kind);
  const params =
    method?.kind === "oauth" || method?.kind === "api-key"
      ? (method.preset?.templateParams ?? [])
      : [];
  let next = initialDraftState(plan, kind);
  for (const param of params) next = withParam(next, plan, param.name, PARAM);
  return next;
}

function mcpScenario(
  state: DraftState,
  mcp: McpInfo & { status: "ok" },
): Scenario {
  const manual = mcp.registration === "manual";
  return {
    state: manual
      ? { ...state, mcpClientId: "client-id", mcpClientSecret: "client-secret" }
      : state,
    profile: {
      ...BASE,
      authorizePath: path(mcp.authorizationEndpoint),
      tokenPath: path(mcp.tokenEndpoint),
      pkce: mcp.pkce.includes("S256") ? "S256" : "none",
      cimd: mcp.registration === "cimd",
      verify: {
        method: "POST",
        path: path(mcp.url),
        header: "Authorization",
        scheme: "Bearer",
        basic: null,
        headers: {},
        accountField: null,
        mcp: true,
      },
    },
  };
}

function keyScenario(state: DraftState, preset: ApiKeyPreset | null): Scenario {
  const verify = preset?.verify;
  return {
    state: {
      ...state,
      method: "api-key",
      keySubject: "user",
      serviceUrls: state.serviceUrls.map(fill),
    },
    profile: {
      ...BASE,
      authorizePath: "/-",
      tokenPath: "/-",
      pkce: "none",
      verify:
        verify && preset
          ? {
              method: verify.method,
              path: decodeURIComponent(path(fill(verify.url))),
              header: preset.header,
              scheme: preset.scheme,
              basic: preset.basic,
              headers: filledHeaders(verify),
              accountField: verify.accountField,
              mcp: false,
            }
          : null,
    },
  };
}

/** A server the person names when nothing is known about the service. */
function withServer(state: DraftState): DraftState {
  if (state.oauth.serverUrl) return state;
  return {
    ...state,
    oauth: {
      ...state.oauth,
      serverUrl: "https://auth.example.test",
      authorizationEndpoint: "https://auth.example.test/authorize",
      tokenEndpoint: "https://auth.example.test/token",
    },
  };
}

function oauthScenario(
  plan: ConnectPlan,
  given: DraftState,
  preset: OauthPreset | null,
): Scenario {
  const assisted = given.oauth.registration !== "manual" && plan.registry;
  const served = withServer(given);
  const state = assisted
    ? served
    : {
        ...served,
        oauth: {
          ...served.oauth,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      };
  const verify = preset?.verify;
  return {
    state,
    profile: {
      ...BASE,
      authorizePath: path(state.oauth.authorizationEndpoint),
      tokenPath: path(state.oauth.tokenEndpoint),
      pkce: state.oauth.pkce,
      cimd: assisted && state.oauth.registration === "cimd",
      requiredParams: state.oauth.authorizationParams,
      verify: verify
        ? {
            method: verify.method,
            path: path(fill(verify.url)),
            header: verify.header,
            scheme: verify.scheme,
            basic: null,
            headers: filledHeaders(verify),
            accountField: verify.accountField,
            mcp: false,
          }
        : null,
    },
  };
}

export function scenario(plan: ConnectPlan, kind: ConnectMethodKind): Scenario {
  const state = withParams(plan, kind);
  const method = plan.methods.find((m) => m.kind === kind);
  if (method?.kind === "mcp" && method.mcp.status === "ok") {
    return mcpScenario(state, method.mcp);
  }
  if (method?.kind === "api-key") return keyScenario(state, method.preset);
  return oauthScenario(
    plan,
    state,
    method?.kind === "oauth" ? method.preset : null,
  );
}
