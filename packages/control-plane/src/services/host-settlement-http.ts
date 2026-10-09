/**
 * Optional Host HTTP drain. The Rust Host is never required: Identity-plane
 * ceremony settlement is the complete consume effect. The implicit default
 * loopback Host URL is a suggestion, not a configured executor.
 */

import type { ControlPlaneConfig } from "../config.js";
import { secureServiceEndpoint } from "../deployment-mode.js";
import type { HostSettlementOutcome } from "./host-settlement.js";

const IMPLICIT_HOST_API = new Set([
  "http://127.0.0.1:8787",
  "http://localhost:8787",
]);

/** True only when a deployment opted into a Host executor. */
export function hostSettlementDispatchEnabled(
  config: ControlPlaneConfig,
): boolean {
  if (!config.operatorToken) return false;
  return !IMPLICIT_HOST_API.has(config.hostApiUrl.replace(/\/$/, ""));
}

function hostSettleUrl(configuredUrl: string): URL | undefined {
  try {
    const base = secureServiceEndpoint(configuredUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL("api/v1/interaction-subjects/settle", base);
  } catch {
    return undefined;
  }
}

export async function dispatchHostSettlementHttp(
  config: ControlPlaneConfig,
  payload: {
    readonly eventType: string;
    readonly interactionId: string;
    readonly requestDigest?: string;
  },
): Promise<HostSettlementOutcome> {
  if (!config.operatorToken) return "outcome_unknown";
  const url = hostSettleUrl(config.hostApiUrl);
  if (!url) return "outcome_unknown";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-operator": config.operatorToken,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel();
    if (res.ok) return "succeeded";
    return "outcome_unknown";
  } catch {
    return "outcome_unknown";
  }
}
