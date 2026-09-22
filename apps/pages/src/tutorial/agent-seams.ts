/**
 * Where the support panel gets its agents from.
 *
 * `support.guided-help` owns the panel, the guide runtime and the renderer;
 * the agents that answer belong to other capabilities — the browser Prompt
 * API and the configured model provider to `support.local-ai`, the AG-UI
 * transport to `support.remote-ai`. Each of those runtimes installs its
 * loader here in `activate` and puts the absent loader back in `dispose`, so
 * the engine never imports an agent whose capability was not approved. The
 * defaults answer "no agent", which the engine already treats as the
 * offline, written-help-only mode.
 */

import type { SupportAgentPort } from "@opensesame/support-agent";

export type PromptApiAgentModule = Readonly<{
  createPromptApiAgent: () => SupportAgentPort | null;
}>;
export type ProviderAgentModule = Readonly<{
  createProviderAgent: () => SupportAgentPort | null;
}>;
export type AgUiAgentModule = Readonly<{
  createAgUiAgent: () => SupportAgentPort | null;
}>;

export type SupportAgentLoaders = {
  promptApi: () => Promise<PromptApiAgentModule>;
  provider: () => Promise<ProviderAgentModule>;
  agUi: () => Promise<AgUiAgentModule>;
};

const ABSENT: SupportAgentLoaders = {
  promptApi: () => Promise.resolve({ createPromptApiAgent: () => null }),
  provider: () => Promise.resolve({ createProviderAgent: () => null }),
  agUi: () => Promise.resolve({ createAgUiAgent: () => null }),
};

export const supportAgentLoaders: SupportAgentLoaders = { ...ABSENT };

/**
 * Install one or more loaders; returns the restore. Restoring puts back
 * exactly what was there before, so two capabilities disposing in either
 * order leave the absent loaders behind.
 */
export function installSupportAgentLoaders(
  loaders: Partial<SupportAgentLoaders>,
): () => void {
  const previous: Partial<SupportAgentLoaders> = {};
  if (loaders.promptApi) {
    previous.promptApi = supportAgentLoaders.promptApi;
    supportAgentLoaders.promptApi = loaders.promptApi;
  }
  if (loaders.provider) {
    previous.provider = supportAgentLoaders.provider;
    supportAgentLoaders.provider = loaders.provider;
  }
  if (loaders.agUi) {
    previous.agUi = supportAgentLoaders.agUi;
    supportAgentLoaders.agUi = loaders.agUi;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous.promptApi) supportAgentLoaders.promptApi = previous.promptApi;
    if (previous.provider) supportAgentLoaders.provider = previous.provider;
    if (previous.agUi) supportAgentLoaders.agUi = previous.agUi;
  };
}

/** Test-only: every loader back to absent. */
export function resetSupportAgentLoadersForTest(): void {
  Object.assign(supportAgentLoaders, ABSENT);
}
