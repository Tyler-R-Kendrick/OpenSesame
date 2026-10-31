/**
 * Integrations — the sections Settings › Integrations draws, one list.
 *
 * An integration is a connection to a third party that extends a feature or
 * replaces what it does on its own: an identity provider beside browser-local
 * IAM, a key service beside the browser's WebCrypto, a forge the vault backs
 * up to, a password manager that keeps working next to the vault, an agent
 * harness in place of the on-device model. It is configured by reference —
 * the connector's page, its credential sealed in the vault, nothing sent until
 * it is connected — so it is no feature flag: no reviewed plan and no consent
 * receipt, and nothing about it depends on whether a feature is on. (A tile
 * may carry its own enable switch, as a Backups history road does.)
 *
 * These are the Connections catalogue's feature-binding and service families,
 * except legacy local storage, whose group is no longer offered in Integrations.
 * The category remains internal so its old rows do not move to the general
 * catalog when this group is removed.
 *
 * Where an integration shares its id with a feature (`identity`, `ai`, …) it
 * extends that feature's switches; where it does not (`backups`,
 * `encryption`, …) the function it extends is built in (ADR 0142) and has
 * none. Pure data: no store, no React, no network.
 */

import type { CapabilityId } from "@opensesame/capability-composition";
import type { ProviderCategory } from "../connections.js";
import { FEATURES, type FeatureId } from "./features.js";

export type IntegrationId =
  | "identity"
  | "encryption"
  | "certificates"
  | "backups"
  | "password-managers"
  | "cloud-secret-storage"
  | "payments"
  | "password-reset"
  | "ai"
  | "networking"
  | "services";

export type Integration = Readonly<{
  id: IntegrationId;
  title: string;
  /** Connector families configured in this section. */
  providerCategories: readonly ProviderCategory[];
  /** The feature whose switches this extends; absent for a built-in function. */
  extendsFeature?: FeatureId;
  /**
   * The always-on capabilities this section's providers work through. An
   * operator may withdraw one (ADR 0142); the section then says so.
   */
  backedBy?: readonly CapabilityId[];
}>;

const integration = (
  id: IntegrationId,
  title: string,
  providerCategories: readonly ProviderCategory[],
  rest: Pick<Integration, "extendsFeature" | "backedBy"> = {},
): Integration => ({ id, title, providerCategories, ...rest });

/**
 * In page order, by topic: who signs in, what protects keys, where secrets
 * live, then what the installation pays with, asks and joins.
 */
export const INTEGRATIONS: readonly Integration[] = [
  integration("identity", "Identity", ["identity"], {
    extendsFeature: "identity",
  }),
  integration("encryption", "Encryption", ["encryption"], {
    backedBy: ["backup.cloud-secrets"],
  }),
  integration("certificates", "Certificate authority", ["certificates"], {
    extendsFeature: "certificates",
  }),
  integration("backups", "Backups", ["backup_recovery"], {
    backedBy: ["backup.git-remote"],
  }),
  integration("password-managers", "Password managers", ["password_managers"]),
  integration("cloud-secret-storage", "Cloud secret storage", [
    "cloud_secret_storage",
  ]),
  integration("payments", "Payments", ["wallet"], {
    extendsFeature: "payments",
  }),
  integration("password-reset", "Password reset", ["cua_runtime"], {
    extendsFeature: "password-reset",
  }),
  integration("ai", "AI", ["agent_harnesses", "ai_model_provider"], {
    extendsFeature: "ai",
  }),
  integration("networking", "Networking", ["networking"], {
    extendsFeature: "networking",
  }),
  integration("services", "Services", [
    "developer",
    "productivity",
    "communication",
    "storage",
    "crm",
  ]),
];

/**
 * Integrations whose function is built in: no feature section carries their
 * id, so an old `#feature-<id>` link to one lands on the Integrations page.
 */
export const BUILT_IN_INTEGRATIONS: ReadonlySet<string> = new Set<string>(
  INTEGRATIONS.filter(
    (entry) => !FEATURES.some((feature) => feature.id === entry.id),
  ).map((entry) => entry.id),
);
