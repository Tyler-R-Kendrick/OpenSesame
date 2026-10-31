import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentClient } from "@opensesame/agent-client";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type {
  CandidateCustody,
  ResetEffects,
  ResetRun,
} from "@opensesame/cua-password-reset";
import type { AccountItem } from "@opensesame/vault-core";
import { z } from "zod";
import {
  BUNDLED_LOCAL_MODULE,
  type LoadedResetConfiguration,
  validateResetConfiguration,
} from "./password-reset-config.js";
import { createLocalPasswordResetEffects } from "./password-reset-local-runtime.js";

export const RESET_LAUNCH_AUDIENCE = "urn:opensesame:agent:mcp-host" as const;

export type ResetRuntimeContext = {
  run: ResetRun;
  loaded: LoadedResetConfiguration;
  store: VaultStore;
  item: AccountItem;
  candidate: CandidateCustody;
  agent: Pick<AgentClient, "headers" | "forget">;
};

export type ResetEffectsLoader = (
  context: ResetRuntimeContext,
) => Promise<ResetEffects>;

type AdapterModule = {
  createPasswordResetEffects?: unknown;
};

const effectsFactorySchema = z.function({
  input: [z.custom<ResetRuntimeContext>()],
  output: z.custom<ResetEffects | Promise<ResetEffects>>(),
});
const effectsSchema = z.object({
  execute: z.function(),
  backupCandidate: z.function(),
  verifyCandidate: z.function(),
  promoteCandidate: z.function(),
  compensate: z.function(),
});

/** The separately supplied runtime is loaded only after grant and vault checks. */
export const loadResetEffects: ResetEffectsLoader = async (context) => {
  await validateResetConfiguration(
    context.loaded.config,
    context.loaded.directory,
  );
  if (context.loaded.config.runtime.module === BUNDLED_LOCAL_MODULE) {
    const effects = await createLocalPasswordResetEffects(context);
    assertEffects(effects);
    return effects;
  }
  const resource = context.loaded.config.runtime.resource;
  if (!resource) throw new Error("External runtime requires a resource");
  await context.agent.headers(resource);
  const modulePath = resolve(
    context.loaded.directory,
    context.loaded.config.runtime.module,
  );
  const adapter: AdapterModule = await import(pathToFileURL(modulePath).href);
  const parsed = effectsFactorySchema.safeParse(
    adapter.createPasswordResetEffects,
  );
  if (!parsed.success)
    throw new Error("Invalid password-reset runtime adapter");
  const factory = parsed.data;
  const effects = await factory(context);
  assertEffects(effects);
  return effects;
};

function assertEffects(effects: ResetEffects): void {
  if (!effectsSchema.safeParse(effects).success)
    throw new Error("Invalid password-reset runtime effects");
}
