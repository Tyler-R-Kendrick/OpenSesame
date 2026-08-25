import { createChainedAuditSink } from "@opensesame/audit";
import {
  MemoryPrincipalMappingStore,
  type UpstreamAuthDatabase,
  createMemoryChallengeStore,
  createPasskeySeam,
  createSimpleWebAuthnVerifyFn,
} from "@opensesame/auth-upstream";
import { ClaimEngine } from "@opensesame/claims";
import {
  ConflictError,
  type OrgFederationStores,
  type OrganizationStores,
  type ProjectStores,
  type Repositories,
  type SamlStores,
  type ScimStores,
  betterAuthAccounts,
  betterAuthSessions,
  betterAuthUsers,
  betterAuthVerifications,
  createDrizzle,
  createPostgresClientClaimChallengeStore,
  createPostgresClientOriginStore,
  createPostgresClientRecordStore,
  type ConsentStore,
  createPostgresConsentStore,
  createPostgresOidcStore,
  createPostgresOrgFederationStores,
  createPostgresOrganizationStores,
  createPostgresPairwiseStore,
  createPostgresProjectStores,
  createPostgresSamlStores,
  createPostgresScimStores,
  createRepositories,
} from "@opensesame/database";
import {
  MemoryClientRecordStore,
  createOpenSesameProvider,
  createPostgresAdapterConstructor,
} from "@opensesame/oauth-provider";
import { createLogger } from "@opensesame/observability";
import type { Clock } from "@opensesame/os-domain";
import { ProvisionalPolicy } from "@opensesame/policy";
import { createHonoApp } from "./app.js";
import {
  type ControlPlaneConfig,
  assertSecureConfig,
  loadConfig,
} from "./config.js";
import type { AppContext, ControlPlaneRepositories } from "./context.js";
import { IndexedClaimStore } from "./repos/claim-store.js";
// INTEGRATOR (S11): the mailer seam is the whole of this swarm's footprint in
// this file — one import, one context field below. Email delivery for the
// magic-link method (D16) lives in services/mailer.ts.
import { createMailer } from "./services/mailer.js";
import { createAppStores } from "./state.js";

export interface CreateControlPlaneOptions {
  config?: Partial<ControlPlaneConfig>;
  clock?: Clock;
  ready?: boolean;
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Test seam: inject repositories (e.g. an in-process PGlite-backed
   * PostgresRepositories) instead of deriving them from `databaseUrl`.
   */
  repos?: Repositories;
  /**
   * Test seam: inject project stores. Defaults to the Postgres stores when a
   * `databaseUrl` is configured, memory otherwise — this lets route suites run
   * against the Postgres implementation without a server.
   */
  projectStores?: ProjectStores;
  /**
   * Test seam: inject organization stores. Defaults to the Postgres stores
   * when a `databaseUrl` is configured, memory otherwise — the same shape the
   * project stores use, so a route suite can run either implementation
   * without a server.
   */
  organizationStores?: OrganizationStores;
  /**
   * Test seam: inject the Better Auth database. Defaults to the same Drizzle
   * bundle everything else uses when a `databaseUrl` is configured, and to
   * nothing (Better Auth's in-memory adapter) otherwise — so a suite can prove
   * a magic link outlives the instance that minted it without a server.
   */
  betterAuthDatabase?: UpstreamAuthDatabase;
  /** Test seam: inject SCIM stores (same defaulting rule as the org stores). */
  scimStores?: ScimStores;
  /** Test seam: inject the org email-domain + LDAP configuration stores. */
  orgFederationStores?: OrgFederationStores;
  /** Test seam: inject the SAML pending/replay stores. */
  samlStores?: SamlStores;
}

/**
 * The deployment/system principal (ADR 0050 R-A). Auto-admitted origin
 * clients are born owned by this principal, so every client has an owner and
 * owner-fenced reads keep answering 404 to everyone else (no oracle); the F5
 * claim flow transfers ownership to the claiming verified principal. The id
 * is fixed so the row is ensured idempotently across restarts and replicas.
 */
export const SYSTEM_OWNER_PRINCIPAL_ID = "prn_opensesame_system";

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

  const baseRepos =
    options.repos ??
    createRepositories(
      config.databaseUrl ? { databaseUrl: config.databaseUrl } : undefined,
    );
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
    auditEvents: {
      append: (event) => chainedAudit.append(event),
      list: (filter) => baseRepos.auditEvents.list(filter),
    },
  };
  const claimStore = new IndexedClaimStore(clock);
  const claims = new ClaimEngine({
    pepper: config.claimPepper,
    store: claimStore,
    clock,
  });
  // With a database configured the issuer keeps its own models — sessions,
  // authorization codes, refresh tokens, device flows — in Postgres. On the
  // in-memory adapter every restart silently invalidates live sessions and a
  // consumed authorization code stops being remembered as consumed.
  const drizzleBundle = config.databaseUrl
    ? createDrizzle(config.databaseUrl)
    : undefined;
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
  // The system owner principal must exist before the first auto-admission
  // writes owner_principal_id (a FK against Postgres). createControlPlane is
  // synchronous, so the promise travels on the context and the server awaits
  // it before accepting traffic.
  const systemPrincipalReady = ensureSystemOwnerPrincipal(repos, clock);
  systemPrincipalReady.catch((error) => {
    log.error({ err: error }, "failed to ensure system owner principal");
  });
  // Late-bound: `stores` is assembled after the provider, but the lookup only
  // runs per authorization request, long after both exist.
  let consentLookupStore: ConsentStore | undefined;
  const oauth = createOpenSesameProvider({
    issuer: config.issuer,
    processEnv: options.processEnv ?? process.env,
    clientStore,
    systemOwnerPrincipalId: SYSTEM_OWNER_PRINCIPAL_ID,
    // Durable consent reuse: the rows finishConsentAllow writes come back as
    // grants, so a decision already remembered is not asked again in a new
    // browser session. Conservative on purpose — a consent carrying resource
    // indicators falls through to the prompt rather than being replayed
    // without them.
    findStoredConsent: async (accountId, clientId) => {
      const record = await consentLookupStore?.findActive(accountId, clientId);
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
  const mappings = new MemoryPrincipalMappingStore();
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
  consentLookupStore = stores.consents;
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
    mailer: createMailer(processEnv, config),
    // The same pool everything else on this context uses, so a magic link
    // written by one request is readable by the next — and by another replica.
    ...(betterAuthDatabase ? { betterAuthDatabase } : undefined),
    systemOwnerPrincipalId: SYSTEM_OWNER_PRINCIPAL_ID,
    systemPrincipalReady,
  };

  const app = createHonoApp(ctx);
  return { app, ctx, config };
}

export type ControlPlane = ReturnType<typeof createControlPlane>;
