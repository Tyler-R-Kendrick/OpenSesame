/**
 * `support.guided-help` — the support panel, the authored help topics and
 * the Driver.js guides that *point* at authored targets and never act
 * (ADR 0088): the shell wrapper that mounts the panel, and the two guidance
 * tools (`opensesame_help`, `opensesame_guide_start`) that let an in-browser
 * agent open help or start an authored walkthrough by id.
 *
 * `driver.js`, `@opensesame/guide-lang`, `@opensesame/guide-runtime` and
 * `@opensesame/support-agent` are exclusive to this capability, and inside
 * it they are reached only through `import()` — the panel is `lazy`
 * (`tutorial/ui/SupportLauncher.tsx`) and the engine is assembled in
 * `loadBrowserEngine` (`tutorial/session.ts`) on first open. Activating the
 * capability therefore costs one button; the renderer and the parser arrive
 * when somebody asks a question.
 *
 * The model's reach is unchanged by this wrapping: it may emit GuideLang and
 * nothing else, an id it names is resolved through the target registry or
 * the program is discarded whole, and page context is assembled from the
 * authored registries rather than from the DOM. The two tools take an
 * authored topic or goal id and reject anything else.
 *
 * Egress: none of this module's own. The agents that answer belong to
 * `support.local-ai` (on-device) and `support.remote-ai` (a configured
 * endpoint); each installs its loader into `tutorial/agent-seams.ts` from
 * its own `activate`, and the default here answers "no agent", which the
 * engine already treats as offline, written-help-only mode.
 *
 * Side effects: none at import. `SupportProvider` subscribes to the lock bus
 * from an effect rather than at construction, so React discarding a
 * controller in StrictMode leaves no handler holding the session's keys.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { SUPPORT_TOOLS } from "../../webmcp/support-tools.js";
import { createActivation } from "../activation.js";
import { type ContextWithPorts, tagWebMcpTool } from "../ports-b.js";
import { SupportShell } from "./SupportShell.js";

export const CAPABILITY = "support.guided-help";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(context) {
    const ctx = context as ContextWithPorts;
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // Without the port the panel is not mounted (ports-b.ts); the tools
    // still register and stay harmless — their seam defaults are no-ops.
    const wrapper = ctx.registerShellWrapper?.({
      id: "support",
      Wrapper: SupportShell,
      order: 10,
    });
    if (wrapper) activation.onDispose(() => wrapper.revoke());

    for (const tool of SUPPORT_TOOLS) {
      activation.register("webmcp-tool", tagWebMcpTool(tool));
    }

    return activation.handle();
  },
};
