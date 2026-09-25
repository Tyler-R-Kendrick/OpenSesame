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
  type ConnectMethodKind,
  type ConnectPlan,
  type McpInfo,
  fillTemplate,
} from "@opensesame/app-core/lib/connect-plan.js";
import {
  VERIFY_TARGETS,
  type VerifyTarget,
} from "../../../server/connect-verify-targets.generated.mjs";
import type { ProviderProfile } from "./provider-emulator.js";

export const PARAM = "acme.example";

type Scenario = { profile: ProviderProfile; state: DraftState };

const BASE = { registerPath: "/register", cimd: false, requiredParams: {} };

const path = (url: string) => new URL(url).pathname;

/** Every placeholder filled with the test value; `{key}` stays. */
export const fill = (url: string) =>
  fillTemplate(
    url,
    new Proxy({}, { get: (_t, name) => (name === "key" ? undefined : PARAM) }),
  );

/**
 * The verify call the provider emulator answers: the relay's own pinned
 * target for this service (`connect-verify-targets.generated.mjs`), with the
 * test's account host filled in.
 */
function verifyProfile(
  target: VerifyTarget | undefined,
): ProviderProfile["verify"] {
  if (!target) return null;
  return {
    method: target.method,
    path: decodeURIComponent(path(fill(target.url))),
    header: target.header,
    scheme: target.scheme,
    basic: target.basic,
    headers: Object.fromEntries(
      Object.entries(target.headers).map(([k, v]) => [k, fill(v)]),
    ),
    accountField: target.accountField,
    mcp: false,
  };
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

function keyScenario(plan: ConnectPlan, state: DraftState): Scenario {
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
      verify: verifyProfile(VERIFY_TARGETS[plan.id]?.apiKey),
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

function oauthScenario(plan: ConnectPlan, given: DraftState): Scenario {
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
  return {
    state,
    profile: {
      ...BASE,
      authorizePath: path(state.oauth.authorizationEndpoint),
      tokenPath: path(state.oauth.tokenEndpoint),
      pkce: state.oauth.pkce,
      cimd: assisted && state.oauth.registration === "cimd",
      requiredParams: state.oauth.authorizationParams,
      verify: verifyProfile(VERIFY_TARGETS[plan.id]?.oauth),
    },
  };
}

export function scenario(plan: ConnectPlan, kind: ConnectMethodKind): Scenario {
  const state = withParams(plan, kind);
  const method = plan.methods.find((m) => m.kind === kind);
  if (method?.kind === "mcp" && method.mcp.status === "ok") {
    return mcpScenario(state, method.mcp);
  }
  if (method?.kind === "api-key") return keyScenario(plan, state);
  return oauthScenario(plan, state);
}
