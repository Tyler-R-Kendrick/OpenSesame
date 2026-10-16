/**
 * deepsec agent backend: Grok Build CLI (subscription), headless via `grok -p`.
 * Wave-2 investigate: shallow pass then automatic 150-turn deep retry on cap/timeout.
 */
import type { DeepsecPlugin } from "deepsec/config";
import {
  DEFAULT_GROK_MODEL,
  createHeadlessDeepsecAgent,
} from "./deepsec-headless-agent-core.js";
import type { InvestigateParams } from "./deepsec-headless-agent-types.js";
import {
  grokDeepMaxTurns,
  grokShallowMaxTurns,
  runGrokPromptWithMeta,
} from "./grok-agent-prompt.js";
import {
  grokWave2Investigate,
  logGrokDepthSummaryLine,
} from "./grok-wave2-investigate.js";

const HeadlessTemplate = createHeadlessDeepsecAgent({
  type: "grok",
  providerLabel: "Grok Build",
  defaultModel: DEFAULT_GROK_MODEL,
  runPrompt: async (params) => {
    const run = await runGrokPromptWithMeta({
      ...params,
      maxTurns: params.maxTurns ?? grokShallowMaxTurns(),
    });
    if (!run.text.trim()) {
      throw new Error("grok produced empty output");
    }
    return run.text;
  },
});

class GrokWave2Agent extends HeadlessTemplate {
  override investigate(params: InvestigateParams) {
    return grokWave2Investigate(params, {
      type: "grok",
      providerLabel: "Grok Build",
      defaultModel: DEFAULT_GROK_MODEL,
    });
  }
}

export const grokAgentPlugin: DeepsecPlugin = {
  name: "opensesame-grok-build",
  agents: [new GrokWave2Agent()],
};

export { grokShallowMaxTurns, grokDeepMaxTurns, logGrokDepthSummaryLine };
