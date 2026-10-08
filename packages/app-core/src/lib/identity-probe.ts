import { overlapCast } from "@opensesame/os-domain";
import {
  identityPlaneRequest,
  isDeviceIdentityMode,
} from "./device-identity.js";
import {
  type FailureClass,
  classifyResponse,
  classifyThrown,
} from "./probe-failure.js";
const PROBE_MS = 4000;

export type HealthState = "unknown" | "reachable" | "unreachable";

/** A probe result that says *why*, for the connectivity monitor. */
export type ProbeResult = {
  health: HealthState;
  failure: FailureClass | null;
};

export async function probeIdentityHealth(
  baseUrl: () => string,
): Promise<ProbeResult> {
  // Device-native mode is always the local host — never probe the network.
  if (isDeviceIdentityMode()) {
    return { health: "reachable", failure: null };
  }
  const base = baseUrl();
  if (!base) return { health: "unreachable", failure: null };
  try {
    const res = await identityPlaneRequest("/v1/health/live", {
      credentials: "omit",
      timeoutMs: PROBE_MS,
    });
    if (!res.ok) {
      return { health: "unreachable", failure: classifyResponse(res.status) };
    }
    // A foreign listener on :8788 can answer with 401 JSON and look "up".
    // OpenSesame control-plane always returns `{ "status": "ok" }`.
    try {
      const body = overlapCast(await res.json());
      return body.status === "ok"
        ? { health: "reachable", failure: null }
        : { health: "unreachable", failure: "not-opensesame" };
    } catch {
      return { health: "unreachable", failure: "not-opensesame" };
    }
  } catch (error) {
    const thrown =
      error instanceof DOMException || error instanceof Error
        ? error
        : String(error);
    return { health: "unreachable", failure: classifyThrown(thrown) };
  }
}
