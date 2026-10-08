import gate from "../../../spec/conformance/cli-reveal-gate.json" with {
  type: "json",
};
import { emitStderrLine } from "./output.js";

export type HumanRevealVerb = "read" | "env-resolve" | "pass-reveal";

export interface HumanRevealRequest {
  verb: HumanRevealVerb;
  reveal: boolean;
  desktop: boolean;
  /** When set and starts with `op://`, `--desktop` is required. */
  reference?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdinIsTty?: boolean | undefined;
  stdoutIsTty?: boolean | undefined;
}

type AgentRule = (typeof gate.agentContextEnv)[number];

function ruleMatches(rule: AgentRule, env: NodeJS.ProcessEnv): boolean {
  const raw = env[rule.name];
  if (raw === undefined || raw === "") return false;
  if (rule.match === "nonEmpty") return true;
  if (rule.match === "equals") return raw === rule.value;
  return false;
}

/** Refuse-only: a missing marker never grants human reveal. */
export function detectAgentContext(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return gate.agentContextEnv.some((rule) => ruleMatches(rule, env));
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
  const env = request.env ?? process.env;
  if (detectAgentContext(env)) {
    return `Refusing plaintext ${request.verb} in an agent context. ${gate.migrationHint}`;
  }
  const { stdin, stdout } = ttyPair(request);
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

export function assertHumanReveal(request: HumanRevealRequest): void {
  const refusal = humanRevealRefusal(request);
  if (refusal) throw new Error(refusal);
}

export interface RevealReceipt {
  verb: HumanRevealVerb;
  lane: "reveal";
  principal: "human";
  agentContext: boolean;
  reference?: string | undefined;
  at: string;
}

export function emitRevealReceipt(
  request: Pick<HumanRevealRequest, "verb" | "reference" | "env">,
): void {
  const receipt: RevealReceipt = {
    verb: request.verb,
    lane: "reveal",
    principal: "human",
    agentContext: detectAgentContext(request.env),
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
