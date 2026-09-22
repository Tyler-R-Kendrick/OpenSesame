/**
 * The resolver's input. Everything the resolver may look at is here; it
 * reads no clock, no storage, no DOM and no network. Time is `facts.now`.
 */
import type {
  CapabilityCatalog,
  ConsentReceipt,
  DistributionContract,
  InstallationCapabilitySelection,
  InstanceCapabilityPolicy,
  PolicyProvenance,
  RuntimeFacts,
  VaultCapabilitySelection,
  WorkspaceCapabilityRestriction,
} from "./types.js";

export type ResolveInput = Readonly<{
  catalog: CapabilityCatalog;
  distribution: DistributionContract;
  /** `null` = personal-local: the ceiling is every distributed optional capability. */
  instancePolicy: InstanceCapabilityPolicy | null;
  provenance: PolicyProvenance;
  /** `false` → managed-invalid: core-only plan, POLICY_UNVERIFIED on every optional. */
  policyValid: boolean;
  workspace: WorkspaceCapabilityRestriction | null;
  installation: InstallationCapabilitySelection | null;
  vault: VaultCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  facts: RuntimeFacts;
  installationId: string;
  vaultId: string | null;
}>;
