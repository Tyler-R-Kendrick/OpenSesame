import type {
  InvestigateParams,
  RevalidateParams,
  RunPromptParams,
  TriageParams,
} from "./deepsec-headless-agent-types.js";
import { runHeadlessInvestigate } from "./deepsec-headless-investigate.js";
import { runHeadlessRevalidate } from "./deepsec-headless-revalidate.js";
import { runHeadlessTriage } from "./deepsec-headless-triage.js";

export function createHeadlessDeepsecAgent(options: {
  type: string;
  providerLabel: string;
  defaultModel: string;
  runPrompt: (params: RunPromptParams) => Promise<string>;
}) {
  const agentOptions = {
    type: options.type,
    providerLabel: options.providerLabel,
    defaultModel: options.defaultModel,
    runPrompt: options.runPrompt,
  };

  return class HeadlessDeepsecAgent {
    type = options.type;

    investigate(params: InvestigateParams) {
      return runHeadlessInvestigate(params, agentOptions);
    }

    revalidate(params: RevalidateParams) {
      return runHeadlessRevalidate(params, agentOptions);
    }

    triage(params: TriageParams) {
      return runHeadlessTriage(params, agentOptions);
    }
  };
}
