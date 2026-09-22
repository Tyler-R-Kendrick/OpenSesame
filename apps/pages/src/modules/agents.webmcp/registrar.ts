/**
 * The one place `@opensesame/webmcp` is loaded.
 *
 * `webmcp/lifecycle.ts` imports the SDK at module scope, which is fine for
 * a page that always had WebMCP and wrong for a capability that may not be
 * approved: a static import is a reference the bundle graph follows. So the
 * registrar is reached through `import()` here, from inside the background
 * job, and a build where `agents.webmcp` is excluded never loads it.
 *
 * What is registered is the *contributed* tool set — every `webmcp-tool`
 * entry the core kept after filtering by the plan's approved operations —
 * not `WEBMCP_TOOLS`. A capability that is not approved therefore has no
 * tool here, and no handler of its is imported by this surface.
 *
 * The human-root fence is unchanged and still wraps every execute: an agent
 * calling through the model context can never unwrap the human vault root
 * (`lib/vault/protection/agent-boundary.ts`).
 */

import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { assertAgentMayNotUnwrapHumanRoot } from "../../lib/vault/protection/agent-boundary.js";
import {
  noteWebMcpAccepted,
  noteWebMcpFailure,
  noteWebMcpRegistered,
  noteWebMcpUnregistered,
} from "../../webmcp/registration.js";

const APP_ID = "opensesame-pages";

export type WebMcpScope = "boot" | "session";

/** Test seam: the SDK import, so a suite can prove it is never touched. */
export const webMcpSdkSeams = {
  load: (): Promise<typeof import("@opensesame/webmcp")> =>
    import("@opensesame/webmcp"),
};

function fenced(tools: readonly WebMcpToolSpec[]): WebMcpToolSpec[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (args) => {
      assertAgentMayNotUnwrapHumanRoot({
        alias: tool.name,
        purpose: "workload-root",
      });
      return tool.execute(args);
    },
  }));
}

/**
 * Register one scope with the browser's model context. Resolves to the
 * unregister; on an aborted signal it registers nothing and resolves to a
 * no-op, so a disable landing during the SDK fetch leaves no tools behind.
 */
export async function registerWebMcpScope(
  scope: WebMcpScope,
  tools: readonly WebMcpToolSpec[],
  signal: AbortSignal,
): Promise<() => void> {
  if (signal.aborted) return () => {};
  const { createWebMcpRegistrar, detectModelContext } =
    await webMcpSdkSeams.load();
  if (signal.aborted) return () => {};

  const api = detectModelContext();
  const registrar = createWebMcpRegistrar(api, {
    appId: APP_ID,
    onRegistered: noteWebMcpAccepted,
    onFailure: noteWebMcpFailure,
  });
  noteWebMcpRegistered(
    api?.source ?? null,
    scope,
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      scope,
    })),
  );
  const unregister = registrar.register(fenced(tools));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    unregister();
    noteWebMcpUnregistered(scope);
  };
}
