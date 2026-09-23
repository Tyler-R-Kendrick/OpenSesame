/**
 * Injection points for the composition store: where the catalog and the
 * distribution come from, which lock manager serializes commits, the clock,
 * the installation id, and the two hooks other owners fill in — a workspace
 * restriction (S03/S04) and managed-policy verification (S03). Tests replace
 * these; production code never reads them directly.
 */

import type {
  CapabilityCatalog,
  DistributionContract,
  InstanceCapabilityPolicy,
  WorkspaceCapabilityRestriction,
} from "@opensesame/capability-composition";
import { capabilityArtifacts } from "../../host.js";
import { installationId as readInstallationId } from "./installation.js";
import type { ManagedPolicyReview } from "./store-docs.js";

export type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export const storeSeams = {
  catalog: (): Promise<CapabilityCatalog> =>
    import("./catalog.js").then((m) => m.CAPABILITY_CATALOG),
  distribution: (): Promise<DistributionContract> =>
    capabilityArtifacts().distribution(),
  locks: (): LockManagerLike | undefined =>
    typeof navigator === "undefined" ? undefined : navigator.locks,
  now: (): string => new Date().toISOString(),
  installationId: (): string => readInstallationId(),
  /** S03/S04: a per-vault narrowing, when one is stored. */
  workspaceRestriction: (
    _instanceId: string,
    _vaultId: string | null,
  ): WorkspaceCapabilityRestriction | null => null,
  /** S03: envelope/revision/rollback verification of a managed policy. */
  reviewManagedPolicy: (
    _policy: InstanceCapabilityPolicy,
  ): ManagedPolicyReview => ({
    ok: true,
    diagnostics: [],
  }),
};
