import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { ephemeralTerminalCorrelationId } from "@opensesame/app-core/lib/cli-app-integration/terminal-session.js";
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import { verifyLocalDaemonForCliAppIntegration } from "./daemon-pin.js";
import type { HumanRevealVerb } from "./reveal-gate.js";

export type CliAppIntegrationDecision =
  | "approve"
  | "deny"
  | "unavailable"
  | "expired"
  | "timedOut";

export interface CliAppIntegrationPort {
  ensureReveal(input: {
    verb: HumanRevealVerb;
    terminalSessionId: string;
    reference?: string | undefined;
  }): Promise<CliAppIntegrationDecision>;
}

function daemonBase(): string | undefined {
  const raw =
    process.env.OPENSESAME_DAEMON_API ??
    process.env.OPENSESAME_DAEMON_LISTEN ??
    "http://127.0.0.1:18790";
  if (!raw.trim()) return undefined;
  const withScheme = raw.includes("://") ? raw : `http://${raw}`;
  return withScheme.replace(/\/$/, "");
}

async function pollEnsure(
  base: string,
  terminalSessionId: string,
  verb: HumanRevealVerb,
  reference?: string | undefined,
): Promise<CliAppIntegrationDecision> {
  const path = cliAppIntegrationPolicy.daemonPaths.ensure;
  const deadline =
    Date.now() + cliAppIntegrationPolicy.requestTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terminalSessionId,
        verb,
        reference,
      }),
    });
    if (response.status === 404 || response.status === 503)
      return "unavailable";
    if (!response.ok) return "deny";
    const body: BoundaryValue = await response.json();
    if (!isJsonObject(body)) return "deny";
    const status = readString(body.status);
    if (status === "approved") return "approve";
    if (status === "expired") return "expired";
    if (status === "denied") return "deny";
    if (status === "wrongSession") return "deny";
    await new Promise((resolve) => {
      setTimeout(resolve, cliAppIntegrationPolicy.pollIntervalMs);
    });
  }
  return "timedOut";
}

export function createCliAppIntegrationPort(): CliAppIntegrationPort {
  return {
    async ensureReveal(input) {
      const base = daemonBase();
      if (!base) return "unavailable";
      try {
        if (!(await verifyLocalDaemonForCliAppIntegration(base))) {
          return "unavailable";
        }
        return await pollEnsure(
          base,
          input.terminalSessionId,
          input.verb,
          input.reference,
        );
      } catch {
        return "unavailable";
      }
    },
  };
}

export async function terminalSessionIdForReveal(): Promise<string> {
  return await ephemeralTerminalCorrelationId();
}
