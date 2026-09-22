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

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { AiStep } from "../../screens/setup/steps/AiStep.js";
import { installSupportAgentLoaders } from "../../tutorial/agent-seams.js";
import { SETTINGS_READ_TOOL } from "../../webmcp/settings-tools.js";
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
        promptApi: () => import("../../tutorial/agents/prompt-api/index.js"),
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

    return activation.handle();
  },
};
