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
 * (`agents/ag-ui/endpoint.ts`). The endpoint itself is read once per
 * activation from this origin's `os-runtime-config.json`; with none
 * configured the remote transport stays off, and dispose forgets it.
 *
 * Side effects: none at import. The config read is a `background-job` under
 * the lease, so a capability disabled mid-flight fetches nothing further.
 */

import type { EgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { readCommand } from "@opensesame/app-core/lib/command-bar/parse.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "@opensesame/app-core/lib/feature-connector-operation.js";
import { savedFeatureRequests } from "@opensesame/app-core/lib/feature-request.js";
import type {
  ModelExchange,
  ModelPostOptions,
} from "@opensesame/app-core/lib/hosted-inference.js";
import { savedModelRequests } from "@opensesame/app-core/lib/model-provider.js";
import { createSavedModelSupportAgent } from "@opensesame/app-core/lib/saved-model-agent.js";
import {
  applyAgUiEndpoint,
  loadAgUiEndpoint,
} from "@opensesame/app-core/tutorial/agents/ag-ui/endpoint.js";
import { installSupportAgentLoaders } from "../../tutorial/agent-seams.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "support.remote-ai";

/** Test seam: the deploy-config read, swappable without a module mock. */
interface RemoteSupportSeams {
  loadAgUiEndpoint: typeof loadAgUiEndpoint;
}

export const remoteSupportSeams: RemoteSupportSeams = { loadAgUiEndpoint };

/** The model operation for a saved api-key connector, with no Host required. */
export function savedRemoteModel(
  provider: Provider | string,
): FeatureOperation {
  return runListedFeature(provider);
}

/**
 * Send every saved agent-harness request. The key is on those requests,
 * never on the same-origin support endpoint and never on the model record.
 * Each request is the operation `savedRemoteModel` returned.
 */
export function loadSavedRemoteModels(post: ModelPostOptions): ModelExchange[] {
  const operations = savedFeatureRequests(["agent_harnesses"]).map((row) =>
    savedRemoteModel(row.providerId),
  );
  return savedModelRequests(operations, post);
}

let acceptedModels: ModelExchange[] = [];

/** Inference requests this capability has accepted. Secrets stay on their headers. */
export function acceptedRemoteModels(): readonly ModelExchange[] {
  return acceptedModels;
}

/** @internal test hook */
export function resetAcceptedRemoteModelsForTest(): void {
  acceptedModels = [];
}

function secretsStayOnHeaders(row: ModelExchange & { ok: true }): boolean {
  const packed = JSON.stringify(row.body);
  return Object.values(row.headers).every(
    (value) => value === "" || !packed.includes(value),
  );
}

/** AG-UI when an endpoint is configured, otherwise the saved model connector. */
interface RemoteAgentModule {
  readonly createAgUiAgent: () => ReturnType<
    typeof createSavedModelSupportAgent
  >;
}

export async function loadRemoteAgentModule(): Promise<RemoteAgentModule> {
  const ag = await import(
    "@opensesame/app-core/tutorial/agents/ag-ui/index.js"
  );
  return {
    createAgUiAgent: () =>
      ag.createAgUiAgent() ?? createSavedModelSupportAgent(),
  };
}

/** Read the configured endpoint once, unless the lease already aborted. */
export function startAgUiEndpointLoad(
  signal: AbortSignal,
  egress: EgressPort,
): void {
  if (signal.aborted) return;
  const post: ModelPostOptions = { egress, signal };
  acceptedModels = loadSavedRemoteModels(post).filter(
    (row): row is ModelExchange & { ok: true } =>
      row.ok && secretsStayOnHeaders(row),
  );
  signal.addEventListener(
    "abort",
    () => {
      acceptedModels = [];
    },
    { once: true },
  );
  void remoteSupportSeams.loadAgUiEndpoint().then(
    (endpoint) => {
      // Disabled while the read was in flight: the address is not kept.
      if (signal.aborted && endpoint !== null) applyAgUiEndpoint(null);
    },
    () => {
      // No runtime config, or an address that failed validation: the
      // remote transport stays off, which is the default.
    },
  );
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.onDispose(
      installSupportAgentLoaders({
        provider: () =>
          import("@opensesame/app-core/tutorial/agents/provider/index.js"),
        agUi: () => loadRemoteAgentModule(),
      }),
    );
    activation.onDispose(() => {
      acceptedModels = [];
      applyAgUiEndpoint(null);
    });

    activation.register("background-job", {
      id: "ag-ui-endpoint",
      start: (signal) => startAgUiEndpointLoad(signal, ctx.egress),
    });
    // The bar stays a command parser until a model capability is on. This
    // one does not interpret; it only opens the ask road. On-device
    // interpretation sorts first (order 10).
    activation.register("command-assist", {
      id: "remote",
      order: 30,
      interpret: (utterance) => Promise.resolve(readCommand(utterance)),
    });

    return activation.handle();
  },
};
