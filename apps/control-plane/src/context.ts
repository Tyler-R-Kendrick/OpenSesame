import type { Logger } from "@opensesame/observability";
import type { ClaimEngine } from "@opensesame/claims";
import type { Repositories } from "@opensesame/database";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import type {
  MemoryPrincipalMappingStore,
  PasskeyChallengeStore,
  PasskeySeam,
} from "@opensesame/auth-upstream";
import type { ProvisionalPolicy } from "@opensesame/policy";
import type { Clock } from "@opensesame/os-domain";
import type { ControlPlaneConfig } from "./config.js";
import type { AppStores } from "./state.js";
import type { IndexedClaimStore } from "./repos/claim-store.js";

export interface AppContext {
  config: ControlPlaneConfig;
  log: Logger;
  repos: Repositories;
  claimStore: IndexedClaimStore;
  claims: ClaimEngine;
  oauth: OpenSesameProviderBundle;
  mappings: MemoryPrincipalMappingStore;
  policy: ProvisionalPolicy;
  stores: AppStores;
  clock: Clock;
  ready: boolean;
  passkeys: PasskeySeam;
  passkeyChallenges: PasskeyChallengeStore;
}
