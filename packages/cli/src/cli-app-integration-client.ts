import {
  cliAppIntegrationPolicy,
  deriveTerminalSessionId,
} from "@opensesame/app-core/lib/cli-app-integration/index.js";
import type { HumanRevealVerb } from "./reveal-gate.js";

export type CliAppIntegrationDecision = "approve" | "deny" | "unavailable";

export interface CliAppIntegrationPort {
  ensureReveal(
    input: {
      verb: HumanRevealVerb;
      terminalSessionId: string;
      reference?: string | undefined;
    },
  ): Promise<CliAppIntegrationDecision>;
}

function seamDecision(): CliAppIntegrationDecision | undefined {
  const raw = process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM;
  if (raw === "approve" || raw === "deny" || raw === "unavailable") return raw;
  return undefined;
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terminalSessionId,
        verb,
        reference,
      }),
    });
    if (response.status === 404 || response.status === 503) return "unavailable";
    if (!response.ok) return "deny";
    const body = (await response.json()) as { status?: string };
    if (body.status === "approved") return "approve";
    if (body.status === "denied") return "deny";
    if (body.status === "wrongSession") return "deny";
    await new Promise((resolve) => {
      setTimeout(resolve, cliAppIntegrationPolicy.pollIntervalMs);
    });
  }
  return "deny";
}

export function createCliAppIntegrationPort(): CliAppIntegrationPort {
  return {
    async ensureReveal(input) {
      const seam = seamDecision();
      if (seam) return seam;
      const base = daemonBase();
      if (!base) return "unavailable";
      try {
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

export function terminalSessionIdForReveal(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return deriveTerminalSessionId(env);
}
