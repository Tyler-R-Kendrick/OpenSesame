import { createChainedAuditSink } from "@opensesame/audit";
import {
  MemoryPrincipalMappingStore,
  createAuthenticationService,
} from "@opensesame/auth-upstream";
import { ClaimEngine } from "@opensesame/claims";
import {
  ConflictError,
  type ConsentStore,
  MemoryRepositories,
  PostgresRepositories,
  type Repositories,
  betterAuthAccounts,
  betterAuthSessions,
  betterAuthUsers,
  betterAuthVerifications,
  createDrizzle,
  createMemoryAuthenticationServiceStores,
  createPostgresAuthenticationServiceStores,
  createPostgresClientClaimChallengeStore,
  createPostgresClientOriginStore,
  createPostgresClientRecordStore,
  createPostgresConsentStore,
  createPostgresOidcStore,
  createPostgresOrgFederationStores,
  createPostgresOrganizationStores,
  createPostgresPairwiseStore,
  createPostgresProjectStores,
  createPostgresSamlStores,
  createPostgresScimStores,
  runMigrations,
} from "@opensesame/database";
// INTEGRATOR (S11): the mailer seam is the whole of this swarm's footprint in
// this file — one import, one context field below. Email delivery for the
// magic-link method (D16) lives in services/mailer.ts.
import {
  MemoryClientRecordStore,
  createOpenSesameProvider,
  createPostgresAdapterConstructor,
} from "@opensesame/oauth-provider";
import { createLogger } from "@opensesame/observability";
import type { Clock } from "@opensesame/os-domain";
import { ProvisionalPolicy } from "@opensesame/policy";
import { createHonoApp } from "./app.js";
import type { AppContext, ControlPlaneRepositories } from "./context.js";
import type { CreateControlPlaneOptions } from "./create-app-options.js";
import { resolveControlPlaneConfig } from "./create-app-options.js";
import { createPasskeys } from "./create-passkeys.js";
import { IndexedClaimStore } from "./repos/claim-store.js";
import { DurableClaimStore } from "./repos/durable-claim-store.js";
import { DurablePrincipalMappingStore } from "./repos/durable-mapping-store.js";
import { installDurableSecurityMaps } from "./repos/security-maps.js";
import { verifySecurityDatabase } from "./repos/security-readiness.js";
import { hostAuthorizationAudiences } from "./services/host-authorization.js";
import { createMailer } from "./services/mailer.js";
import { createNotificationCallbackAdapters } from "./services/notification-callbacks.js";
import { createSmsBridge } from "./services/sms-bridge.js";
import { createAppStores } from "./state.js";

export type { CreateControlPlaneOptions } from "./create-app-options.js";

/**
 * The deployment/system principal (ADR 0050 R-A). Auto-admitted origin
 * clients are born owned by this principal, so every client has an owner and
 * owner-fenced reads keep answering 404 to everyone else (no oracle); the F5
 * claim flow transfers ownership to the claiming verified principal. The id
 * is fixed so the row is ensured idempotently across restarts and replicas.
 */
export const SYSTEM_OWNER_PRINCIPAL_ID = "prn_opensesame_system";

/** Late-binding slot: the consent store lands here once `stores` exists. */
type ConsentLookupSlot = { store?: ConsentStore };

/**
 * Ensure the deployment/system principal row exists (idempotent). The
 * `oauth_clients.owner_principal_id` FK makes this a precondition for
 * auto-admitting an owned origin client against Postgres.
 */
export async function ensureSystemOwnerPrincipal(
  repos: Pick<Repositories, "principals">,
  clock: Clock,
): Promise<void> {
  const existing = await repos.principals.getById(SYSTEM_OWNER_PRINCIPAL_ID);
  if (existing) return;
  const now = clock();
  try {
    await repos.principals.create({
      id: SYSTEM_OWNER_PRINCIPAL_ID,
      state: "active",
      assurance: "verified",
      createdAt: now,
      updatedAt: now,
      verifiedAt: now,
      version: 1,
    });
  } catch (error) {
    // A concurrent replica created it first — that is the desired end state.
    if (!(error instanceof ConflictError)) throw error;
  }
}

export function createControlPlane(options: CreateControlPlaneOptions = {}) {
  const processEnv = options.processEnv ?? process.env;
  const config = resolveControlPlaneConfig(options, processEnv);
  const hostAudiences = hostAuthorizationAudiences(
    processEnv,
    config.isProduction,
    config.publicUrl,
  );
  const clock: Clock = options.clock ?? (() => new Date());
  const log = createLogger({ name: "control-plane", level: config.logLevel });
  const drizzleBundle = options.database
    ? { db: options.database }
    : config.databaseUrl
      ? createDrizzle(config.databaseUrl)
      : undefined;

  const baseRepos =
    options.repos ??
    (drizzleBundle
      ? new PostgresRepositories(drizzleBundle.db)
      : new MemoryRepositories());
  // Every audit write goes through the chain, so a trail cannot be quietly
  // rewritten by anything that cannot recompute every later digest. The tip is
  // read from the store on the first append: starting each process at genesis
  // would leave one disconnected run per restart, which is indistinguishable
  // from a deleted tail.
  const chainedAudit = createChainedAuditSink(
    {
      append: (event) => baseRepos.auditEvents.append(event),
    },
    {
      tip: async () => {
        const [newest] = await baseRepos.auditEvents.list({ limit: 1 });
        return newest?.digest;
      },
      retryOnConflict: (error) => {
        return (
          "code" in error &&
          error.code === "23505" &&
          "constraint_name" in error &&
          error.constraint_name === "audit_events_previous_digest_uidx"
        );
      },
    },
  );
  const repos: ControlPlaneRepositories = {
    ...baseRepos,
    // Class methods are on the prototype; object spread would drop them.
    transaction: (fn) => baseRepos.transaction(fn),
    auditEvents: {
      append: (event) => chainedAudit.append(event),
      list: (filter) => baseRepos.auditEvents.list(filter),
    },
  };
  const claimStore = drizzleBundle
    ? new DurableClaimStore(drizzleBundle.db)
    : new IndexedClaimStore(clock);
  const claims = new ClaimEngine({
    pepper: config.claimPepper,
    store: claimStore,
    clock,
  });
  // With a database configured the issuer keeps its own models — sessions,
  // authorization codes, refresh tokens, device flows — in Postgres. On the
  // in-memory adapter every restart silently invalidates live sessions and a
  // consumed authorization code stops being remembered as consumed.
  const oidcStore = drizzleBundle
    ? createPostgresOidcStore(drizzleBundle.db)
    : undefined;
  const pairwiseStore = drizzleBundle
    ? createPostgresPairwiseStore(drizzleBundle.db)
    : undefined;
  // One durable client store shared by the registration API and the OIDC
  // provider's dynamic client resolution (ADR 0050 R-C): a client registered
  // through the API is immediately usable in flows, and origin clients
  // auto-admitted on /auth survive restarts (pairwise sectors stay stable).
  const clientStore = drizzleBundle
    ? createPostgresClientRecordStore(drizzleBundle.db)
    : new MemoryClientRecordStore();
  const clientClaimChallengeStore = drizzleBundle
    ? createPostgresClientClaimChallengeStore(drizzleBundle.db)
    : undefined;
  const clientOriginStore = drizzleBundle
    ? createPostgresClientOriginStore(drizzleBundle.db)
    : undefined;
  // Durable consent records (ADR 0050 F6): human-given consents survive a
  // restart exactly like the clients they cover; memory only in tests/dev.
  const consentStore = drizzleBundle
    ? createPostgresConsentStore(drizzleBundle.db)
    : undefined;
  // Durable projects + memberships (WP-8): the same rows the projects API
  // serves survive a restart; memory only in tests/dev.
  const projectStores =
    options.projectStores ??
    (drizzleBundle ? createPostgresProjectStores(drizzleBundle.db) : undefined);
  // Durable organizations + memberships (ADR 0055): a tenant's SSO issuer is
  // read on the login path, so it has to outlive the process that configured
  // it. The rest of the federation storage follows the same rule — memory in
  // tests/dev, Postgres the moment a database is configured.
  const organizationStores =
    options.organizationStores ??
    (drizzleBundle
      ? createPostgresOrganizationStores(drizzleBundle.db)
      : undefined);
  const scimStores =
    options.scimStores ??
    (drizzleBundle ? createPostgresScimStores(drizzleBundle.db) : undefined);
  const orgFederationStores =
    options.orgFederationStores ??
    (drizzleBundle
      ? createPostgresOrgFederationStores(drizzleBundle.db)
      : undefined);
  const samlStores =
    options.samlStores ??
    (drizzleBundle ? createPostgresSamlStores(drizzleBundle.db) : undefined);
  const authenticationStores =
    options.authenticationStores ??
    (drizzleBundle
      ? createPostgresAuthenticationServiceStores(drizzleBundle.db)
      : createMemoryAuthenticationServiceStores());
  const authentication = createAuthenticationService(
    authenticationStores,
    clock,
  );
  // The system owner principal must exist before the first auto-admission
  // writes owner_principal_id (a FK against Postgres). createControlPlane is
  // synchronous, so the promise travels on the context and the server awaits
  // it before accepting traffic.
  const systemPrincipalReady = (async () => {
    if (config.databaseUrl && drizzleBundle && !options.database) {
      await runMigrations(config.databaseUrl);
    }
    if (drizzleBundle) await verifySecurityDatabase(drizzleBundle.db);
    await ensureSystemOwnerPrincipal(repos, clock);
  })();
  systemPrincipalReady.catch(() => {
    log.error("security_state_initialization_failed");
  });
  // Late-bound: `stores` is assembled after the provider, but the lookup only
  // runs per authorization request, long after both exist.
  const consentLookup: ConsentLookupSlot = {};
  const oauth = createOpenSesameProvider({
    issuer: config.issuer,
    env: { isProduction: config.isProduction },
    processEnv: options.processEnv ?? process.env,
    clientStore,
    systemOwnerPrincipalId: SYSTEM_OWNER_PRINCIPAL_ID,
    // Durable consent reuse: the rows finishConsentAllow writes come back as
    // grants, so a decision already remembered is not asked again in a new
    // browser session. Conservative on purpose — a consent carrying resource
    // indicators falls through to the prompt rather than being replayed
    // without them.
    findStoredConsent: async (accountId, clientId) => {
      const record = await consentLookup.store?.findActive(accountId, clientId);
      if (!record || record.resources.length > 0) return null;
      return { scopes: record.scopes, claims: record.claims };
    },
    ...(oidcStore && pairwiseStore
      ? {
          adapter: createPostgresAdapterConstructor(oidcStore),
          pairwiseStore,
        }
      : undefined),
  });
  const mappings = drizzleBundle
    ? new DurablePrincipalMappingStore(drizzleBundle.db)
    : new MemoryPrincipalMappingStore();
  const policy = new ProvisionalPolicy();
  const stores = createAppStores({
    oauthClients: clientStore,
    ...(clientClaimChallengeStore
      ? { clientClaimChallenges: clientClaimChallengeStore }
      : undefined),
    ...(clientOriginStore ? { clientOrigins: clientOriginStore } : undefined),
    ...(consentStore ? { consents: consentStore } : undefined),
    ...(projectStores ? { projectStores } : undefined),
    ...(organizationStores ? { organizationStores } : undefined),
    ...(scimStores ? { scimStores } : undefined),
    ...(orgFederationStores ? { orgFederationStores } : undefined),
    ...(samlStores ? { samlStores } : undefined),
  });
  consentLookup.store = stores.consents;
  if (drizzleBundle)
    installDurableSecurityMaps(
      stores,
      drizzleBundle.db,
      config.provisionalTtlMs,
    );
  const passkeyComponents = createPasskeys(config, drizzleBundle?.db);

  const betterAuthDatabase =
    options.betterAuthDatabase ??
    (drizzleBundle
      ? {
          drizzle: drizzleBundle.db,
          schema: {
            // Keyed by Better Auth's own model names; the SQL tables they
            // resolve to are the `better_auth_*` ones.
            user: betterAuthUsers,
            session: betterAuthSessions,
            account: betterAuthAccounts,
            verification: betterAuthVerifications,
          },
        }
      : undefined);

  const ctx: AppContext = {
    hostAuthorizationAudiences: hostAudiences,
    ...passkeyComponents,
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
    authentication,
    authenticationStores,
    mailer: createMailer(processEnv, config),
    sms: options.sms ?? createSmsBridge(processEnv),
    notificationCallbackAdapters:
      options.notificationCallbackAdapters ??
      createNotificationCallbackAdapters(config.notifications),
    // The same pool everything else on this context uses, so a magic link
    // written by one request is readable by the next — and by another replica.
    ...(betterAuthDatabase ? { betterAuthDatabase } : undefined),
    systemOwnerPrincipalId: SYSTEM_OWNER_PRINCIPAL_ID,
    systemPrincipalReady,
    securityStateReady: async () => {
      try {
        await systemPrincipalReady;
        if (drizzleBundle) await verifySecurityDatabase(drizzleBundle.db);
        return true;
      } catch {
        return false;
      }
    },
  };

  const app = createHonoApp(ctx);
  return { app, ctx, config };
}

export type ControlPlane = ReturnType<typeof createControlPlane>;
