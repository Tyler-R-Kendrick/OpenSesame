/**
 * Transport status as this browser can honestly show it.
 *
 * Five dimensions, kept apart (directive "Status and evidence model"):
 * desired policy, credential, runtime, observed authentication, enforcement.
 * The browser reads them from an operator route on the configured endpoint
 * and never collapses them into one lifecycle — a green credential is not a
 * loaded runtime, an observed handshake is not enforcement, and a verified
 * enforcement is stale the moment the generation moves on.
 *
 * Nothing here runs at boot. A request leaves this tab only when a person
 * opens the panel or presses a key on it (UI-BROWSER: never probe on launch).
 */
import { overlapCast } from "@opensesame/os-domain";
import { readBoundedObject } from "./bounded-response.js";
import {
  HostSessionError,
  hostFetch,
  hostLocalSessionEligible,
} from "./identity.js";
import {
  type FailureClass,
  type ProbeThrownValue,
  classifyResponse,
  classifyThrown,
} from "./probe-failure.js";
import { type PagesSettings, loadSettings } from "./settings.js";
import {
  type TransportStatusView,
  parseTransportStatusView,
} from "./transport-model.js";
import { normalizeApiBase } from "./urls.js";
import { useSettingsEpoch } from "./use-settings.js";

export const TRANSPORT_STATUS_PATH = "/api/v1/operator/transport/status";
export const TRANSPORT_VERIFY_PATH = "/api/v1/operator/transport/verify";
/** Bodies are bounded ≤ 64 KiB (CONTRACT §6). */
export const TRANSPORT_RESPONSE_MAX_BYTES = 65_536;
export const TRANSPORT_REQUEST_TIMEOUT_MS = 8_000;

/** The endpoint whose status this tab may read, or null when none is set. */
export function transportVerifierOrigin(
  settings: PagesSettings = loadSettings(),
): string | null {
  const raw = settings.hostApi.trim();
  return raw ? normalizeApiBase(raw) : null;
}

/** Re-renders when the endpoint changes; false on every fresh origin. */
export function useTransportVerifierConfigured(): boolean {
  useSettingsEpoch();
  return transportVerifierOrigin() !== null;
}

export type TransportStatusResult =
  | { kind: "view"; view: TransportStatusView; fetchedAt: string }
  | { kind: "accepted"; status: number }
  | { kind: "unconfigured" }
  | { kind: "unauthorized"; status: number | null }
  | { kind: "degraded"; failure: FailureClass; status: number | null }
  | { kind: "malformed" };

/** Test seam: the two roads a request may take, and the clock. */
export const transportStatusSeams = {
  hostLocalSessionEligible,
  hostFetch,
  fetch: (input: string, init: RequestInit): Promise<Response> =>
    fetch(input, init),
  now: (): number => Date.now(),
};

async function request(
  path: string,
  method: "GET" | "POST",
): Promise<Response> {
  const origin = transportVerifierOrigin();
  if (!origin) throw new HostSessionError("setup_required", "no endpoint");
  const init: RequestInit = {
    method,
    headers: { accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(TRANSPORT_REQUEST_TIMEOUT_MS),
  };
  // The approved DPoP grant when this browser holds one; otherwise the route
  // is asked anonymously, which reaches it (or not) and answers 401 — a
  // reachability fact about the target, never a fallback credential.
  if (transportStatusSeams.hostLocalSessionEligible()) {
    return transportStatusSeams.hostFetch(path, init);
  }
  return transportStatusSeams.fetch(`${origin}${path}`, init);
}

let last: TransportStatusResult | null = null;

/** The most recent answer this tab has seen. Never triggers a request. */
export function lastTransportStatus(): TransportStatusResult | null {
  return last;
}

export function resetTransportStatusForTests(): void {
  last = null;
}

/**
 * One request to the endpoint, settled into a typed outcome. `"view"` reads
 * the body as a status view; `"accepted"` only records that a 2xx came back.
 */
export async function settleTransportRequest(
  path: string,
  method: "GET" | "POST",
): Promise<TransportStatusResult> {
  if (transportVerifierOrigin() === null) return { kind: "unconfigured" };
  let response: Response;
  try {
    response = await request(path, method);
  } catch (error: unknown) {
    if (error instanceof HostSessionError)
      return { kind: "unauthorized", status: null };
    const thrown: ProbeThrownValue = overlapCast(error);
    return { kind: "degraded", failure: classifyThrown(thrown), status: null };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized", status: response.status };
  }
  if (!response.ok) {
    return {
      kind: "degraded",
      failure: classifyResponse(response.status),
      status: response.status,
    };
  }
  if (method === "POST") return { kind: "accepted", status: response.status };
  try {
    const body = await readBoundedObject(
      response,
      TRANSPORT_RESPONSE_MAX_BYTES,
      TRANSPORT_REQUEST_TIMEOUT_MS,
    );
    const view = parseTransportStatusView(body);
    if (!view) return { kind: "malformed" };
    return {
      kind: "view",
      view,
      fetchedAt: new Date(transportStatusSeams.now()).toISOString(),
    };
  } catch {
    return { kind: "malformed" };
  }
}

/**
 * `transport.status.view` on the PWA surface: GET the status view. Explicit
 * action only — the panel opening or its key — never at boot.
 */
export async function readTransportStatus(): Promise<TransportStatusResult> {
  last = await settleTransportRequest(TRANSPORT_STATUS_PATH, "GET");
  return last;
}
