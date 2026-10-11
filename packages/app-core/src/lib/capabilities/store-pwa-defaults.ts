import type {
  CapabilityCatalog,
  ConsentReceipt,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";
import type { CommitOutcome, CompositionSnapshot } from "./store-types.js";

type PwaDefaultStore = Readonly<{
  getSnapshot: () => CompositionSnapshot;
  catalog: () => CapabilityCatalog | null;
  preview: (draft: InstallationCapabilitySelection) => EffectivePlan;
  commit: (
    draft: InstallationCapabilitySelection,
    receipt: ConsentReceipt,
  ) => Promise<CommitOutcome>;
}>;

/** Personal-local PWA: Access and browser-local IAM on first boot (persona D2). */
export async function commitPersonalLocalPwaDefaultsIfNeeded(
  store: PwaDefaultStore,
  now: () => string,
): Promise<void> {
  const snap: CompositionSnapshot = store.getSnapshot();
  if (snap.selection !== null) return;
  if (snap.provenance !== "personal-local") return;
  if (snap.status !== "ready") return;
  const catalog = store.catalog();
  const plan = snap.plan;
  if (!catalog || !plan) return;
  const acceptedAt = now();
  const draft: InstallationCapabilitySelection = {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: plan.identity.instanceId,
    installationId: plan.identity.installationId,
    basePolicyRevision: plan.identity.policyRevision,
    revision: `draft-${acceptedAt}-${crypto.randomUUID().slice(0, 8)}`,
    acceptedRequired: [],
    selectedOptional: ["access.authority", "identity.local-iam"],
    chosenAlternatives: {},
    delivery: { prefetch: "selected", offlineCache: "selected-only" },
  };
  const preview = store.preview(draft);
  const { buildConsentReceipt } = await import("@opensesame/capability-composition");
  const receipt = buildConsentReceipt(preview, catalog, acceptedAt);
  await store.commit(draft, receipt);
}
