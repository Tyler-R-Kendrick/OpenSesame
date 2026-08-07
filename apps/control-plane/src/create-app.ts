import { createLogger } from "@opensesame/observability";
import { ClaimEngine } from "@opensesame/claims";
import { createRepositories } from "@opensesame/database";
import { createOpenSesameProvider } from "@opensesame/oauth-provider";
import { MemoryPrincipalMappingStore, createPasskeySeam } from "@opensesame/auth-upstream";
import { ProvisionalPolicy } from "@opensesame/policy";
import type { Clock } from "@opensesame/os-domain";
import {
  assertSecureConfig,
  loadConfig,
  type ControlPlaneConfig,
} from "./config.js";
import type { AppContext } from "./context.js";
import { createHonoApp } from "./app.js";
import { IndexedClaimStore } from "./repos/claim-store.js";
import { createAppStores } from "./state.js";

export interface CreateControlPlaneOptions {
  config?: Partial<ControlPlaneConfig>;
  clock?: Clock;
  ready?: boolean;
  processEnv?: NodeJS.ProcessEnv;
}

export function createControlPlane(options: CreateControlPlaneOptions = {}) {
  const base = loadConfig(options.processEnv ?? process.env);
  const config: ControlPlaneConfig = { ...base, ...options.config };
  assertSecureConfig(config);
  const clock: Clock = options.clock ?? (() => new Date());
  const log = createLogger({ name: "control-plane", level: config.logLevel });

  const repos = createRepositories(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : undefined,
  );
  const claimStore = new IndexedClaimStore();
  const claims = new ClaimEngine({
    pepper: config.claimPepper,
    store: claimStore,
    clock,
  });
  const oauth = createOpenSesameProvider({
    issuer: config.issuer,
    processEnv: options.processEnv ?? process.env,
  });
  const mappings = new MemoryPrincipalMappingStore();
  const policy = new ProvisionalPolicy();
  const stores = createAppStores();
  // DEV: accept assertion when credential is registered and signature is non-empty.
  const passkeys = createPasskeySeam({
    verifyAssertion: async (assertion, _credential) =>
      assertion.signature.byteLength > 0,
  });

  const ctx: AppContext = {
    config,
    log,
    repos,
    claimStore,
    claims,
    oauth,
    mappings,
    policy,
    stores,
    clock,
    ready: options.ready ?? true,
    passkeys,
  };

  const app = createHonoApp(ctx);
  return { app, ctx, config };
}

export type ControlPlane = ReturnType<typeof createControlPlane>;
