/**
 * Boot-time deployment config — `os-runtime-config.json` beside the bundle.
 *
 * A static Pages deploy cannot bake `VITE_*` endpoints without a rebuild, so
 * deploy-pages.sh writes this small same-origin file instead and the app reads
 * it once before first render. The build ships `{}` so the fetch is a 200
 * even when no endpoints are configured; every failure still resolves to
 * "no config" rather than blocking boot.
 *
 * The file carries endpoint URLs for the Settings layer and, optionally, the
 * instance capability policy (ownership.md §4.4). It can never extend the
 * compiled upstream trust list (ADR 0033 §2) — a hijacked config could at
 * worst point this app at a different Identity API, which is the same power
 * the Settings screen already grants — and an *invalid* policy section fails
 * closed: the store enters `managed-invalid` and loads nothing optional.
 *
 * Only the core endpoints are applied here. The ambient-SSO policy, the
 * support agent endpoint and the Connect callback base are read by the
 * optional modules that own them from `runtimeConfigSnapshot()`.
 */

import {
  type InstanceCapabilityPolicy,
  parseInstancePolicy,
} from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { type RuntimeEndpointConfig, applyRuntimeConfig } from "./settings.js";

const RUNTIME_CONFIG_FETCH_MS = 3000;

export type RuntimeEndpoints = RuntimeEndpointConfig & {
  connectCallbackBase?: string;
};

export type ParsedCapabilityComposition = Readonly<{
  instancePolicy: InstanceCapabilityPolicy | null;
  provenance: "same-origin-deployment";
  diagnostics: readonly string[];
}>;

export type ParsedRuntimeConfig = Readonly<{
  /** `absent`: no file or unreachable; `invalid`: a section failed validation. */
  status: "absent" | "ok" | "invalid";
  /** Applied by core Settings only. */
  endpoints: RuntimeEndpoints;
  /** Applied by `identity.ambient-sso`'s runtime, not here. */
  ambientAuth: BoundaryValue | undefined;
  /** Null for a personal-local installation (no section served). */
  capabilityComposition: ParsedCapabilityComposition | null;
  diagnostics: readonly string[];
}>;

const ABSENT: ParsedRuntimeConfig = Object.freeze({
  status: "absent",
  endpoints: {},
  ambientAuth: undefined,
  capabilityComposition: null,
  diagnostics: [],
});

function readEndpoint(value: BoundaryValue | undefined): string | undefined {
  return isString(value) && value.trim() ? value.trim() : undefined;
}

function readEndpoints(body: Record<string, BoundaryValue>): RuntimeEndpoints {
  const out: RuntimeEndpoints = {};
  const hostApi = readEndpoint(body.hostApi);
  const identityApi = readEndpoint(body.identityApi);
  const daemonApi = readEndpoint(body.daemonApi);
  const mfaAppUrl = readEndpoint(body.mfaAppUrl);
  const supportAgentUrl = readEndpoint(body.supportAgentUrl);
  const connectCallbackBase = readEndpoint(body.connectCallbackBase);
  if (hostApi) out.hostApi = hostApi;
  if (identityApi) out.identityApi = identityApi;
  if (daemonApi) out.daemonApi = daemonApi;
  if (mfaAppUrl) out.mfaAppUrl = mfaAppUrl;
  if (supportAgentUrl) out.supportAgentUrl = supportAgentUrl;
  if (connectCallbackBase) out.connectCallbackBase = connectCallbackBase;
  return out;
}

/**
 * `{ "capabilityComposition": { "schemaVersion": 1, "instancePolicy": {…} } }`.
 * Anything else under that key is a diagnostic and a null policy, and the
 * caller's status becomes `invalid` — never a permissive default.
 */
function readCapabilityComposition(
  value: BoundaryValue,
): ParsedCapabilityComposition {
  const diagnostics: string[] = [];
  if (!isJsonObject(value)) {
    diagnostics.push("capabilityComposition: not an object");
    return { instancePolicy: null, provenance: "same-origin-deployment", diagnostics };
  }
  if (value.schemaVersion !== 1) {
    diagnostics.push("capabilityComposition.schemaVersion: expected 1");
  }
  if (!("instancePolicy" in value)) {
    diagnostics.push("capabilityComposition.instancePolicy: missing");
    return { instancePolicy: null, provenance: "same-origin-deployment", diagnostics };
  }
  const parsed = parseInstancePolicy(value.instancePolicy);
  if (!parsed.ok) {
    for (const d of parsed.diagnostics) {
      diagnostics.push(
        `capabilityComposition.instancePolicy${d.path ? `.${d.path}` : ""}: ${d.code}`,
      );
    }
    return { instancePolicy: null, provenance: "same-origin-deployment", diagnostics };
  }
  return {
    instancePolicy: diagnostics.length === 0 ? parsed.value : null,
    provenance: "same-origin-deployment",
    diagnostics,
  };
}

/** Pure: shape one fetched body into the parsed config. */
export function parseRuntimeConfig(body: BoundaryValue): ParsedRuntimeConfig {
  if (!isJsonObject(body)) {
    return {
      ...ABSENT,
      status: "invalid",
      diagnostics: ["os-runtime-config.json: body is not an object"],
    };
  }
  const composition =
    "capabilityComposition" in body
      ? readCapabilityComposition(body.capabilityComposition)
      : null;
  const invalid = composition !== null && composition.diagnostics.length > 0;
  return {
    status: invalid ? "invalid" : "ok",
    endpoints: readEndpoints(body),
    ambientAuth: "ambientAuth" in body ? body.ambientAuth : undefined,
    capabilityComposition: composition,
    diagnostics: composition ? [...composition.diagnostics] : [],
  };
}

async function fetchRuntimeConfigDefault(): Promise<BoundaryValue | null> {
  const base = import.meta.env.BASE_URL || "/";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_CONFIG_FETCH_MS);
  try {
    const response = await fetch(`${base}os-runtime-config.json`, {
      credentials: "omit",
      cache: "no-cache",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: BoundaryValue = await response.json();
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const runtimeConfigSeams = {
  /** The raw same-origin body, or null when nothing was served. */
  fetchRuntimeConfig: fetchRuntimeConfigDefault,
};

let snapshot: ParsedRuntimeConfig = ABSENT;

/**
 * Fetch once, parse, validate, and apply the core endpoints. Safe to call on
 * every boot; the parsed result is also kept for `runtimeConfigSnapshot()`.
 */
export async function loadRuntimeConfig(): Promise<ParsedRuntimeConfig> {
  const body = await runtimeConfigSeams.fetchRuntimeConfig();
  const parsed = body === null ? ABSENT : parseRuntimeConfig(body);
  if (parsed.status !== "absent") {
    applyRuntimeConfig(parsed.endpoints);
  }
  snapshot = parsed;
  return parsed;
}

/** The last parsed config, for the modules that apply their own endpoints. */
export function runtimeConfigSnapshot(): ParsedRuntimeConfig {
  return snapshot;
}

/** Test-only: forget the last parsed config. */
export function resetRuntimeConfigForTest(): void {
  snapshot = ABSENT;
}
