import { createChainedAuditSink } from "@opensesame/audit";
import {
  MemoryPrincipalMappingStore,
  createMemoryChallengeStore,
  createPasskeySeam,
  createSimpleWebAuthnVerifyFn,
} from "@opensesame/auth-upstream";
import { ClaimEngine } from "@opensesame/claims";
import { createRepositories } from "@opensesame/database";
import { createOpenSesameProvider } from "@opensesame/oauth-provider";
import { createLogger } from "@opensesame/observability";
import type { Clock } from "@opensesame/os-domain";
import { ProvisionalPolicy } from "@opensesame/policy";
import { createHonoApp } from "./app.js";
import {
  type ControlPlaneConfig,
  assertSecureConfig,
  loadConfig,
} from "./config.js";
import type { AppContext } from "./context.js";
import { IndexedClaimStore } from "./repos/claim-store.js";
import { createAppStores } from "./state.js";

export interface CreateControlPlaneOptions {
  config?: Partial<ControlPlaneConfig>;
  clock?: Clock;
  ready?: boolean;
  processEnv?: NodeJS.ProcessEnv;
}

function rpIdFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "localhost";
  }
}

export function createControlPlane(options: CreateControlPlaneOptions = {}) {
  const processEnv = options.processEnv ?? process.env;
  const base = loadConfig(processEnv);
  const config: ControlPlaneConfig = { ...base, ...options.config };
  assertSecureConfig(config, processEnv);
  const clock: Clock = options.clock ?? (() => new Date());
  const log = createLogger({ name: "control-plane", level: config.logLevel });

  const baseRepos = createRepositories(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : undefined,
  );
  // Every audit write goes through the chain, so a trail cannot be quietly
  // rewritten by anything that cannot recompute every later digest.
  const chainedAudit = createChainedAuditSink(baseRepos.auditEvents);
  const repos: typeof baseRepos = {
    ...baseRepos,
    auditEvents: {
      append: (event, uow) =>
        uow === undefined
          ? chainedAudit.append(event)
          : baseRepos.auditEvents.append(event, uow),
      list: (filter) => baseRepos.auditEvents.list(filter),
    },
  };
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
  const passkeyChallenges = createMemoryChallengeStore();
  const rp = {
    rpID: rpIdFromUrl(config.publicUrl),
    origin: config.publicUrl.replace(/\/$/, ""),
  };

  // Tests/dev: stub signature length check. Production: SimpleWebAuthn + challenge binding.
  const passkeys = createPasskeySeam({
    verifyAssertion: config.allowDevDefaults
      ? async (assertion, _credential) => assertion.signature.byteLength > 0
      : createSimpleWebAuthnVerifyFn(rp, passkeyChallenges),
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
    passkeyChallenges,
  };

  const app = createHonoApp(ctx);
  return { app, ctx, config };
}

export type ControlPlane = ReturnType<typeof createControlPlane>;
