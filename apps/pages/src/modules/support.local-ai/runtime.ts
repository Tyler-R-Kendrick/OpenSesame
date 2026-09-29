/**
 * `support.local-ai` — the browser's own model. It answers support
 * questions and interprets command-bar utterances on the device, and it is
 * where the choice of which plane runs a website's password-reset model
 * lives (`model_plane.choose` / `model_plane.read`).
 *
 * The agent is installed as a *loader* into `tutorial/agent-seams.ts`, not
 * imported: the support engine calls `supportAgentLoaders.promptApi()` when
 * somebody opens the panel, and while this capability is not approved that
 * loader answers "no agent" — which the engine already treats as offline,
 * written-help-only mode. So the Prompt API adapter is fetched on the first
 * question, never at boot, and never at all on an installation without it.
 *
 * `ai` and `@ai-sdk/provider` are exclusive to this capability: the AI SDK's
 * `generateObject` over the Prompt API is `lib/command-bar/interpret.ts` and
 * the `LanguageModelV2` shim is `lib/command-bar/prompt-model.ts`.
 *
 * Egress: none. The Prompt API is the browser's own model — no endpoint, no
 * key, nothing leaves the device. (The `microphone` permission the
 * descriptor declares is asked for by the mic control when a person presses
 * it, never here.) A *remote* answer is `support.remote-ai`, a separate
 * choice with its own declaration.
 *
 * Side effects: none at import — installing a loader is assigning a
 * function, and the module it names is only `import()`ed when called.
 */

import { browserInference } from "@opensesame/app-core/lib/browser-inference.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { interpretCommand } from "@opensesame/app-core/lib/command-bar/interpret.js";
import {
  autonomousResetAvailable,
  loadModelProvider,
  resolveModelPlane,
} from "@opensesame/app-core/lib/model-provider.js";
import { installAutonomousResetReady } from "@opensesame/app-core/lib/password-reset-mail.js";
import { suggestDraftLabels } from "@opensesame/app-core/lib/vault/draft-suggestions.js";
import { SETTINGS_READ_TOOL } from "@opensesame/app-core/webmcp/settings-tools.js";
import { CommandBarVoice } from "../../components/command-bar-voice.js";
import { AiStep } from "../../screens/setup/steps/AiStep.js";
import { MODEL_PROVIDER_PANEL } from "../../sections/settings/CapabilitySections.js";
import { EmbeddedModelProviderPanel } from "../../sections/settings/ModelProviderPanel.js";
import { DraftSuggestions } from "../../sections/vault/DraftSuggestions.js";
import { installSupportAgentLoaders } from "../../tutorial/agent-seams.js";
import { createActivation } from "../activation.js";
import { tagWebMcpTool } from "../ports-b.js";

export const CAPABILITY = "support.local-ai";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.onDispose(
      installSupportAgentLoaders({
        promptApi: () =>
          import("@opensesame/app-core/tutorial/agents/prompt-api/index.js"),
      }),
    );

    activation.register("setup-panel", {
      id: "ai",
      tab: "ai",
      rail: "AI",
      Panel: AiStep,
      order: 20,
    });
    activation.register("webmcp-tool", tagWebMcpTool(SETTINGS_READ_TOOL));
    // The command bar's model reading and its voice input.
    activation.register("command-assist", {
      id: "on-device",
      order: 10,
      interpret: interpretCommand,
      Voice: CommandBarVoice,
    });
    activation.register("item-draft-assist", {
      id: "on-device",
      order: 10,
      Suggestions: DraftSuggestions,
      suggest: (context, signal) => suggestDraftLabels({ ...context }, signal),
    });
    // Drawn by the AI section of Settings › Capabilities, found by id; the
    // category is one no settings route renders on its own.
    activation.register("settings-panel", {
      id: MODEL_PROVIDER_PANEL,
      label: "Model provider",
      category: "capabilities.ai-models",
      Panel: EmbeddedModelProviderPanel,
      order: 10,
    });
    activation.onDispose(
      installAutonomousResetReady(async () => {
        const verdict = await browserInference();
        return autonomousResetAvailable(
          resolveModelPlane(loadModelProvider(), verdict),
        );
      }),
    );

    return activation.handle();
  },
};
