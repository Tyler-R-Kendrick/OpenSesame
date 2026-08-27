import type { AuditSink } from "@opensesame/audit";
import type {
  AuthenticationService,
  MemoryPrincipalMappingStore,
  PasskeyChallengeStore,
  PasskeySeam,
  UpstreamAuthDatabase,
} from "@opensesame/auth-upstream";
import type { ClaimEngine } from "@opensesame/claims";
import type { Repositories } from "@opensesame/database";
import type { OpenSesameProviderBundle } from "@opensesame/oauth-provider";
import type { Logger } from "@opensesame/observability";
import type { Clock } from "@opensesame/os-domain";
import type { AuthenticationServiceStores } from "@opensesame/os-domain";
import type { ProvisionalPolicy } from "@opensesame/policy";
import type { ControlPlaneConfig } from "./config.js";
import type { IndexedClaimStore } from "./repos/claim-store.js";
import type { Mailer } from "./services/mailer.js";
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
  /**
   * Durable storage for Better Auth's own tables (ADR 0057), when a database is
   * configured. Absent, the bridge builds Better Auth on its in-memory adapter
   * — which is right for a dev run with no `DATABASE_URL` and wrong anywhere a
   * magic link has to survive a deploy or reach a second replica.
   */
  betterAuthDatabase?: UpstreamAuthDatabase;
  policy: ProvisionalPolicy;
  stores: AppStores;
  clock: Clock;
  ready: boolean;
  passkeys: PasskeySeam;
  passkeyChallenges: PasskeyChallengeStore;
  authentication: AuthenticationService;
  authenticationStores: AuthenticationServiceStores;
  /**
   * Outbound email (D16) — the email magic-link is the only sender today.
   * nodemailer's SMTP transport wherever `OPENSESAME_SMTP_URL` is set, its
   * `jsonTransport` under `allowDevDefaults`.
   */
  mailer: Mailer;
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
