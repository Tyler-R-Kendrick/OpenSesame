/**
 * `support.remote-ai` — a support answer from somewhere else: a configured
 * AG-UI endpoint, or a model provider whose key this vault holds. It exists
 * because a browser with no built-in model would otherwise have no answers
 * at all, and it is a separate choice from `support.local-ai` precisely
 * because it is the one that sends page context off the device.
 *
 * Both agents are installed as *loaders* into `tutorial/agent-seams.ts`,
 * not imported: the engine calls them when somebody opens the panel, and
 * while this capability is not approved they answer "no agent". So
 * `@ag-ui/client` — exclusive to this capability, and reached only from
 * `tutorial/agents/ag-ui/transport.ts` behind its own `import()` — is
 * fetched on the first remote question and never on an installation
 * without the capability.
 *
 * Egress (automatic, declared): the configured AG-UI endpoint or model
 * provider, carrying redacted page context. Two things bound it and neither
 * is changed here — the context is assembled from the authored registries
 * rather than from the DOM (ADR 0088), so no secret, item name or folder
 * name has a path into a prompt, and the endpoint is validated as absolute
 * http(s) with nothing smuggled in the authority or the tail
 * (`agents/ag-ui/endpoint.ts`). Deployment endpoint config is read under the
 * activation lease. Without it, only the operator-selected verified model
 * can answer, while External connectors is also active. Disposal destroys
 * captured agents and forgets the endpoint.
 *
 * Side effects: none at import. The config read is a `background-job` under
 * the lease, so a capability disabled mid-flight fetches nothing further.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type ModelExchange,
  modelExchange,
} from "@opensesame/app-core/lib/hosted-inference.js";
import {
  type HostedModelTransport,
  hostedModelAuthority,
} from "@opensesame/app-core/lib/hosted-model-authority.js";
import { createSavedModelSupportAgent } from "@opensesame/app-core/lib/saved-model-agent.js";
import {
  applyAgUiEndpoint,
  loadAgUiEndpoint,
} from "@opensesame/app-core/tutorial/agents/ag-ui/endpoint.js";
import type { SupportAgentPort } from "@opensesame/support-agent";
import { installSupportAgentLoaders } from "../../tutorial/agent-seams.js";
import { createActivation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";

export const CAPABILITY = "support.remote-ai";
interface RemoteSupportSeams {
  loadAgUiEndpoint: typeof loadAgUiEndpoint;
}
export const remoteSupportSeams: RemoteSupportSeams = { loadAgUiEndpoint };
/** Compatibility observations never start inference; a question must await an agent. */
export function savedRemoteModel(provider: Provider | string): ModelExchange {
  return modelExchange(provider);
}
export function loadSavedRemoteModels(): ModelExchange[] {
  return [];
}
export function acceptedRemoteModels(): readonly ModelExchange[] {
  return [];
}
interface RemoteAgentModule {
  readonly createAgUiAgent: () => SupportAgentPort | null;
}

function modelTransport(signal: AbortSignal): HostedModelTransport | null {
  let captured: HostedModelTransport;
  try {
    const authority = hostedModelAuthority();
    if (!authority) return null;
    captured = authority;
  } catch {
    return null;
  }
  return {
    assertCurrent() {
      signal.throwIfAborted();
      captured.assertCurrent();
    },
    fetch(url, init) {
      signal.throwIfAborted();
      captured.assertCurrent();
      const merged = init?.signal ? anySignal([signal, init.signal]) : signal;
      return runUnlessAborted(merged, () =>
        captured.fetch(url, { ...init, signal: merged }),
      );
    },
  };
}
/** Every created agent belongs to this support lease and captures its connector lease. */
export async function loadRemoteAgentModule(
  signal?: AbortSignal,
  onCreated?: (agent: SupportAgentPort) => void,
): Promise<RemoteAgentModule> {
  const ag = await import(
    "@opensesame/app-core/tutorial/agents/ag-ui/index.js"
  );
  if (signal?.aborted) return { createAgUiAgent: () => null };
  const transport = signal ? modelTransport(signal) : null;
  return {
    createAgUiAgent() {
      if (signal?.aborted) return null;
      const agent =
        ag.createAgUiAgent() ??
        createSavedModelSupportAgent(transport ?? undefined);
      if (agent) onCreated?.(agent);
      return agent;
    },
  };
}
/** Config discovery performs no inference and holds no fabricated delivery record. */
export function startAgUiEndpointLoad(signal: AbortSignal): void {
  if (signal.aborted) return;
  void remoteSupportSeams.loadAgUiEndpoint(signal).then(
    () => {},
    () => {
      /* No configured remote endpoint. */
    },
  );
}
export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    const lifetime = new AbortController();
    const signal = anySignal([ctx.lease.signal, lifetime.signal]);
    const agents = new Set<SupportAgentPort>();
    activation.onDispose(
      installSupportAgentLoaders({
        provider: () =>
          import("@opensesame/app-core/tutorial/agents/provider/index.js"),
        agUi: () => loadRemoteAgentModule(signal, (agent) => agents.add(agent)),
      }),
    );
    activation.onDispose(() => {
      for (const agent of agents) agent.destroy();
      agents.clear();
    });
    activation.onDispose(() => applyAgUiEndpoint(null));
    activation.onDispose(() => lifetime.abort());
    activation.register("background-job", {
      id: "ag-ui-endpoint",
      start: (jobSignal) =>
        startAgUiEndpointLoad(anySignal([signal, jobSignal])),
    });
    activation.register("command-assist", {
      id: "remote",
      order: 30,
      interpret: (utterance) => Promise.resolve(readCommand(utterance)),
    });
    return activation.handle();
  },
};
