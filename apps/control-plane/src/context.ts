import type { AuditSink } from "@opensesame/audit";
import type {
  MemoryPrincipalMappingStore,
  PasskeyChallengeStore,
  PasskeySeam,
} from "@opensesame/auth-upstream";
import type { ClaimEngine } from "@opensesame/claims";
import type { Repositories } from "@opensesame/database";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import type { Logger } from "@opensesame/observability";
import type { Clock } from "@opensesame/os-domain";
import type { ProvisionalPolicy } from "@opensesame/policy";
import type { ControlPlaneConfig } from "./config.js";
import type { IndexedClaimStore } from "./repos/claim-store.js";
import type { AppStores } from "./state.js";

export type ControlPlaneRepositories = Omit<Repositories, "auditEvents"> & {
  auditEvents: AuditSink & Pick<Repositories["auditEvents"], "list">;
};

export interface AppContext {
  config: ControlPlaneConfig;
  log: Logger;
  repos: ControlPlaneRepositories;
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
  /**
   * Deployment/system principal that owns auto-admitted origin clients until
   * an F5 claim transfers ownership (ADR 0050 R-A).
   */
  systemOwnerPrincipalId: string;
  /**
   * Resolves once the system owner principal row exists. Awaited before the
   * server accepts traffic so the `owner_principal_id` FK never dangles on
   * the first auto-admission.
   */
  systemPrincipalReady: Promise<void>;
}
