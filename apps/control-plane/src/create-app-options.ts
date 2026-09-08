import type { UpstreamAuthDatabase } from "@opensesame/auth-upstream";
import type {
  Database,
  OrgFederationStores,
  OrganizationStores,
  ProjectStores,
  Repositories,
  SamlStores,
  ScimStores,
} from "@opensesame/database";
import type { ChannelAdapter } from "@opensesame/notification-adapters";
import type { AuthenticationServiceStores, Clock } from "@opensesame/os-domain";
import type { ControlPlaneConfig } from "./config.js";
import { assertSecureConfig, loadConfig } from "./config.js";
import type { NotificationCallbackAdapters } from "./services/notification-callbacks.js";

export interface CreateControlPlaneOptions {
  /** Inject a migrated database for replica/persistence tests, not memory stores. */
  database?: Database;
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
  /** Durable Passwordless/WebAuthn application, user, credential, and token stores. */
  authenticationStores?: AuthenticationServiceStores;
  /**
   * Test seam: inject provider-callback adapters. Defaults to whatever this
   * deployment holds signing material for, which in a stack with no secrets
   * configured is nothing at all.
   */
  notificationCallbackAdapters?: NotificationCallbackAdapters;
  /** The SMS bridge adapter; tests hand in a recording one. */
  sms?: ChannelAdapter;
}
export function resolveControlPlaneConfig(
  options: CreateControlPlaneOptions,
  processEnv: NodeJS.ProcessEnv,
): ControlPlaneConfig {
  const base = loadConfig(processEnv);
  const config = {
    ...base,
    ...options.config,
    // Strict environment parsing establishes a floor. A caller may request
    // stronger safeguards but cannot undo declared production or exposure.
    // assertSecureConfig also raises the floor for the final overridden URLs.
    isProduction: base.isProduction || options.config?.isProduction === true,
  };
  assertSecureConfig(config, processEnv);
  assertProductionStoreOptions(config.isProduction, options);
  return config;
}
export function assertProductionStoreOptions(
  isProduction: boolean,
  options: CreateControlPlaneOptions,
): void {
  if (
    isProduction &&
    (options.database ||
      options.repos ||
      options.projectStores ||
      options.organizationStores ||
      options.scimStores ||
      options.samlStores ||
      options.orgFederationStores ||
      options.authenticationStores ||
      options.betterAuthDatabase)
  ) {
    throw new Error(
      "Production security stores must be constructed from DATABASE_URL",
    );
  }
}
