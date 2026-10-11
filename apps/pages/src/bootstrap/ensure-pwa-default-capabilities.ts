import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";

const DEFAULT_OPTIONALS: InstallationCapabilitySelection["selectedOptional"] = [
  "access.authority",
  "identity.local-iam",
];

export async function ensurePwaDefaultCapabilities(): Promise<void> {
  const snapshot = compositionStore.getSnapshot();
  if (snapshot.selection !== null) return;
  if (snapshot.provenance !== "personal-local") return;
  if (snapshot.status !== "ready") return;

  const now = new Date().toISOString();
  const selection: InstallationCapabilitySelection = {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId:
      snapshot.plan?.identity.instanceId ??
      snapshot.policy?.instanceId ??
      "personal-local",
    installationId: snapshot.plan?.identity.installationId ?? "",
    basePolicyRevision:
      snapshot.plan?.identity.policyRevision ??
      snapshot.policy?.revision ??
      "0",
    revision: `draft-${now}-${crypto.randomUUID().slice(0, 8)}`,
    acceptedRequired: [],
    selectedOptional: DEFAULT_OPTIONALS,
    chosenAlternatives: {},
    delivery: { prefetch: "selected", offlineCache: "selected-only" },
  };
  const { capabilityPorts } = await import(
    "@opensesame/app-core/lib/configuration/capabilities-ports.js"
  );
  const receipt = capabilityPorts.buildConsentReceipt(
    capabilityPorts.previewPlan(selection),
    capabilityPorts.CAPABILITY_CATALOG,
    now,
  );
  await compositionStore.commit(selection, receipt);
}
