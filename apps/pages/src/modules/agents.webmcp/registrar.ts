/**
 * The one place `@opensesame/webmcp` is loaded.
 *
 * The retired `webmcp/lifecycle.ts` imported the SDK at module scope, which
 * was fine for a page that always had WebMCP and wrong for a capability that
 * may not be approved: a static import is a reference the bundle graph follows. So the
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
 * (`lib/vault/protection/agent-boundary.ts`). After it, every execute takes
 * the operation authority check (`authority.ts`) before the handler runs.
 */

import { assertAgentMayNotUnwrapHumanRoot } from "@opensesame/app-core/lib/vault/protection/agent-boundary.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  noteWebMcpAccepted,
  noteWebMcpFailure,
  noteWebMcpRegistered,
  noteWebMcpUnregistered,
} from "@opensesame/app-core/webmcp/registration.js";
import type { WebMcpToolSpec } from "@opensesame/webmcp";
import { authorizeToolCall } from "./authority.js";

const APP_ID = "opensesame-pages";

export type WebMcpScope = "boot" | "session";

/** Test seam: the SDK import, so a suite can prove it is never touched. */
export const webMcpSdkSeams = {
  load: (): Promise<typeof import("@opensesame/webmcp")> =>
    import("@opensesame/webmcp"),
};

function fenced(
  tools: readonly WebMcpToolSpec[],
  assertLive: () => void,
): WebMcpToolSpec[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (args, ceiling) => {
      const check = vaultStore.pinContinuation();
      let assertCurrent = () => {
        check();
        ceiling?.();
        assertLive();
      };
      try {
        assertAgentMayNotUnwrapHumanRoot({
          alias: tool.name,
          purpose: "workload-root",
        });
        assertCurrent();
        // Keep the exact admitted lease across authorization and publication.
        const leaseCheck = await authorizeToolCall(tool);
        assertCurrent = () => {
          check();
          leaseCheck();
          ceiling?.();
          assertLive();
        };
        assertCurrent();
        const result = await tool.execute(args, assertCurrent);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        throw error;
      }
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
  let done = false;
  const assertLive = () => {
    if (done || signal.aborted) throw new Error("webmcp_registration_retired");
  };
  const unregister = registrar.register(fenced(tools, assertLive));
  return () => {
    if (done) return;
    done = true;
    unregister();
    noteWebMcpUnregistered(scope);
  };
}
