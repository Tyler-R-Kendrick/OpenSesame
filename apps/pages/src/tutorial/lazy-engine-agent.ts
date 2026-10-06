/** Optional agents are selected independently of the authored guide runtime. */
import { type SupportAgentPort, SupportError } from "@opensesame/support-agent";
import {
  ABSENT_AGENT_LOADERS,
  type PromptApiAgentModule,
  type SupportAgentLoaders,
  supportAgentLoaders,
} from "./agent-seams.js";
import { type SupportAgentChoice, chooseSupportAgent } from "./choose-agent.js";

const ABSENT_AGENT: SupportAgentPort = {
  availability: () =>
    Promise.resolve({ kind: "unavailable", reason: "no_local_model" }),
  run: () =>
    Promise.reject(
      new SupportError("AGENT_UNAVAILABLE", "No support agent is available."),
    ),
  destroy: () => {},
};

type EngineAgentState = {
  selected: SupportAgentChoice | null;
  loading: Promise<SupportAgentChoice> | null;
  promptModule: PromptApiAgentModule | null;
  destroyed: boolean;
  generation: number;
  provisional: Set<SupportAgentPort>;
};

function abortIfClosed(state: EngineAgentState) {
  if (!state.destroyed) return;
  state.promptModule?.releaseLocalModelSession();
  throw new SupportError("AGENT_ABORTED", "Support was closed.");
}
function discard(state: EngineAgentState, port: SupportAgentPort | null) {
  if (port && state.provisional.delete(port)) port.destroy();
}

async function select(
  state: EngineAgentState,
  loaders: SupportAgentLoaders,
  offline: boolean,
  era: number,
): Promise<SupportAgentChoice> {
  if (offline) return { port: ABSENT_AGENT, transport: "none" };
  const [prompt, providerModule, remoteModule] = await Promise.all([
    loaders.promptApi(),
    loaders.provider(),
    loaders.agUi(),
  ]);
  state.promptModule = prompt;
  abortIfClosed(state);
  if (era !== state.generation)
    throw new SupportError("AGENT_ABORTED", "Model selection changed.");
  const local = prompt.createPromptApiAgent();
  if (local) state.provisional.add(local);
  let provider: SupportAgentPort | null = null;
  try {
    provider = providerModule.createProviderAgent();
    if (provider) state.provisional.add(provider);
    const availability =
      local === null
        ? null
        : await local.availability().catch(() => ({
            kind: "unavailable" as const,
            reason: "platform_unsupported" as const,
          }));
    abortIfClosed(state);
    if (era !== state.generation)
      throw new SupportError("AGENT_ABORTED", "Model selection changed.");
    const choice = chooseSupportAgent(
      local,
      availability,
      provider,
      remoteModule.createAgUiAgent,
      ABSENT_AGENT,
    );
    // The remote chooser already drops the unused local session.
    if (choice.transport === "remote" && local) state.provisional.delete(local);
    if (choice.port !== local) discard(state, local);
    if (choice.port !== provider) discard(state, provider);
    state.provisional.add(choice.port);
    state.selected = choice;
    return choice;
  } catch (cause) {
    discard(state, local);
    discard(state, provider);
    if (cause instanceof SupportError) throw cause;
    throw new SupportError(
      "AGENT_UNAVAILABLE",
      "Support agent is unavailable.",
    );
  }
}

export function lazyEngineAgent(offline: boolean) {
  const loaders = offline ? ABSENT_AGENT_LOADERS : supportAgentLoaders;
  const state: EngineAgentState = {
    selected: null,
    loading: null,
    promptModule: null,
    destroyed: false,
    generation: 0,
    provisional: new Set(),
  };
  function choose() {
    if (state.destroyed)
      return Promise.reject(
        new SupportError("AGENT_ABORTED", "Support was closed."),
      );
    state.loading ??= select(state, loaders, offline, state.generation);
    return state.loading;
  }
  const port: SupportAgentPort = {
    async availability() {
      return (await choose()).port.availability();
    },
    async run(request, options) {
      return (await choose()).port.run(request, options);
    },
    destroy() {
      state.destroyed = true;
      for (const pending of [...state.provisional]) discard(state, pending);
      state.promptModule?.releaseLocalModelSession();
    },
  };
  return {
    port,
    get transport() {
      return state.selected?.transport ?? "none";
    },
    async acquire(onProgress: (fraction: number) => void) {
      const prompt = await loaders.promptApi();
      state.promptModule = prompt;
      abortIfClosed(state);
      await prompt.acquirePromptApiModel(onProgress);
      abortIfClosed(state);
      // A download invalidates choices still waiting on the previous model.
      state.generation += 1;
      for (const pending of [...state.provisional]) discard(state, pending);
      state.selected = null;
      state.loading = null;
    },
  };
}
