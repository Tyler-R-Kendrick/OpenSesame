/**
 * `agents.webmcp` — this page's fenced tools on the browser's model context
 * (`document.modelContext`, with the legacy `navigator.modelContext` as a
 * fallback), so an in-browser agent can read and navigate the app.
 *
 * This capability owns the *surface*, not the tools. Every optional
 * capability contributes its own `webmcp-tool` entries and the core keeps
 * only those whose operations the plan approves; this module registers that
 * filtered set with the browser and takes it all back on dispose.
 *
 * Two groups are registered here because nothing else can. The boot tools
 * (status, navigate, health) describe the app itself rather than a feature.
 * And the core's own tools — the vault item tools, the login draft and the
 * reveal ceremony — belong to capabilities that are always on and therefore
 * have no module to contribute from: when registration moved to
 * contributions they were left with no registrar at all, and every vault
 * tool an agent had disappeared from the surface. They are tagged like
 * everyone else's, so the plan's approved operations still decide which of
 * them a given installation exposes.
 *
 * `@opensesame/webmcp` is exclusive to this capability *and* is reached
 * only through `import()` inside `registrar.ts`. So an installation that
 * did not choose WebMCP never loads the SDK, registers no boot, status or
 * navigation tool, and leaves `document.modelContext` untouched — which is
 * the point: exposing an app to an agent is a decision, not a default.
 *
 * The human-root fence is unchanged: every execute still goes through
 * `assertAgentMayNotUnwrapHumanRoot`, so no tool call can unwrap the human
 * vault root. Navigation still accepts only authored destinations.
 *
 * Egress: none of its own. A tool that reaches a network does so as its own
 * capability's declared egress; this module only makes the call reachable.
 *
 * Side effects: none at import. `useWebMcp` used to register boot tools
 * from `app-root`'s render (`src/app-root.tsx`, before S05's extraction);
 * registration now happens in a `background-job` under this lease, and the
 * session scope from a shell wrapper mounted only while the vault is open.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { BOOT_TOOLS } from "../../webmcp/boot-tools.js";
import { LOGIN_DRAFT_TOOLS } from "../../webmcp/login-tools.js";
import { OPEN_REVEAL_TOOL, VAULT_TOOLS } from "../../webmcp/vault-tools.js";
import { createActivation } from "../activation.js";
import { type ContextWithPorts, tagWebMcpTool } from "../ports-b.js";
import { WebMcpSessionTools } from "./SessionTools.js";
import { startBootTools } from "./surface.js";

export const CAPABILITY = "agents.webmcp";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(context) {
    const ctx = context as ContextWithPorts;
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    // The app's own tools and the core's, tagged so the core filters them by
    // the plan's approved operations exactly as it does everyone else's.
    for (const tool of [
      ...BOOT_TOOLS,
      ...VAULT_TOOLS,
      OPEN_REVEAL_TOOL,
      ...LOGIN_DRAFT_TOOLS,
    ]) {
      activation.register("webmcp-tool", tagWebMcpTool(tool));
    }

    const navigate = ctx.navigate;
    activation.register("background-job", {
      id: "webmcp-boot",
      start: (signal) => startBootTools(signal, navigate),
    });

    // Session tools are filtered by the route, so they bind where the
    // router is: a wrapper the shell mounts only while unlocked (ports-b).
    activation.register("shell-wrapper", {
      id: "webmcp-session",
      Wrapper: WebMcpSessionTools,
      order: 20,
    });

    return activation.handle();
  },
};
