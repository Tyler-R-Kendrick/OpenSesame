import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import gate from "../../../spec/conformance/cli-reveal-gate.json" with {
  type: "json",
};
import {
  type CliAppIntegrationPort,
  createCliAppIntegrationPort,
  terminalSessionIdForReveal,
} from "./cli-app-integration-client.js";
import { emitStderrLine } from "./output.js";

export type HumanRevealVerb = "read" | "env-resolve" | "pass-reveal" | "run";

export interface HumanRevealRequest {
  verb: HumanRevealVerb;
  reveal: boolean;
  desktop: boolean;
  /** When set and starts with `op://`, `--desktop` is required. */
  reference?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdinIsTty?: boolean | undefined;
  stdoutIsTty?: boolean | undefined;
  terminalSessionId?: string | undefined;
  appIntegration?: CliAppIntegrationPort | undefined;
}

function ttyPair(request: HumanRevealRequest) {
  const stdin =
    request.stdinIsTty !== undefined
      ? request.stdinIsTty
      : Boolean(process.stdin.isTTY);
  const stdout =
    request.stdoutIsTty !== undefined
      ? request.stdoutIsTty
      : Boolean(process.stdout.isTTY);
  return { stdin, stdout } satisfies { stdin: boolean; stdout: boolean };
}

export function humanRevealRefusal(
  request: HumanRevealRequest,
): string | undefined {
  const { stdin, stdout } = ttyPair(request);
  if (request.verb !== "run") {
    if (!stdin || !stdout) {
      return `Refusing plaintext ${request.verb}: stdin and stdout must both be interactive terminals (no pipes or capture). ${gate.migrationHint}`;
    }
    if (!request.reveal) {
      return `Refusing plaintext ${request.verb}: pass --reveal after reviewing the risk. ${gate.migrationHint}`;
    }
    const ref = request.reference;
    if (ref?.startsWith("op://") && !request.desktop) {
      return "Refusing op:// reveal without --desktop (1Password app integration).";
    }
    return undefined;
  }
  if (!request.desktop) {
    return "Refusing run without --desktop (OpenSesame app integration).";
  }
  return undefined;
}

export async function humanRevealAppIntegrationRefusal(
  request: HumanRevealRequest,
): Promise<string | undefined> {
  const staticRefusal = humanRevealRefusal(request);
  if (staticRefusal) return staticRefusal;
  const env = request.env ?? process.env;
  const port = request.appIntegration ?? createCliAppIntegrationPort();
  const terminalSessionId =
    request.terminalSessionId ?? terminalSessionIdForReveal(env);
  const decision = await port.ensureReveal({
    verb: request.verb,
    terminalSessionId,
    reference: request.reference,
  });
  if (decision === "approve") return undefined;
  if (decision === "unavailable") {
    return cliAppIntegrationPolicy.messages.appUnavailable;
  }
  if (decision === "deny") {
    return cliAppIntegrationPolicy.messages.denied;
  }
  return cliAppIntegrationPolicy.messages.denied;
}

export async function assertHumanReveal(
  request: HumanRevealRequest,
): Promise<void> {
  const refusal = await humanRevealAppIntegrationRefusal(request);
  if (refusal) throw new Error(refusal);
}

export interface RevealReceipt {
  verb: HumanRevealVerb;
  lane: "reveal";
  principal: "human";
  terminalSessionId: string;
  reference?: string | undefined;
  at: string;
}

export function emitRevealReceipt(
  request: Pick<
    HumanRevealRequest,
    "verb" | "reference" | "env" | "terminalSessionId"
  >,
): void {
  const receipt: RevealReceipt = {
    verb: request.verb,
    lane: "reveal",
    principal: "human",
    terminalSessionId:
      request.terminalSessionId ?? terminalSessionIdForReveal(request.env),
    at: new Date().toISOString(),
  };
  const line = JSON.stringify(
    request.reference === undefined
      ? receipt
      : { ...receipt, reference: request.reference },
  );
  emitStderrLine(line);
}

export const revealGatePolicy = gate;
