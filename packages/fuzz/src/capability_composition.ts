import {
  resolveEffectivePlan,
  validateInstancePolicy,
} from "@opensesame/capability-composition";
import { FuzzedDataProvider } from "./provider.js";

const FRAGMENTS = [
  "a",
  "b",
  "core.fill",
  "-x",
  "__proto__",
  "",
  "UPPER",
  "a b",
  "x".repeat(250),
];

function pick(p: FuzzedDataProvider): string {
  return FRAGMENTS[p.consumeIntegralInRange(0, FRAGMENTS.length - 1)] ?? "a";
}

function pickIds(p: FuzzedDataProvider, max: number): string[] {
  const count = p.consumeIntegralInRange(0, max);
  return Array.from({ length: count }, () => pick(p));
}

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const required = pickIds(p, 4);
  const optional = pickIds(p, 4);
  const prohibited = pickIds(p, 3);
  const descriptors = [pick(p), pick(p), pick(p)].map((id, i) => ({
    id: id === "" ? `cap.${i}` : id,
    descriptorVersion: 1,
    title: "fuzz",
    summary: "",
    dependencies: [] as string[],
    operationIds: [] as string[],
    moduleIds: [`mod.fuzz.${i}`],
    environments: ["document"],
    exposureDigest: "0".repeat(16),
    requiresDocumentReload: false,
    declaredPrivileges: {
      egressOrigins: p.consumeBoolean() ? ["https://fuzz.example"] : [],
      keyAccess: { vaultRead: false, vaultWrite: false, deviceKeys: false },
      browserPermissions: [],
    },
  }));
  const validation = validateInstancePolicy({
    schemaVersion: 1,
    kind: "instance-policy",
    instanceId: "inst-1",
    revision: 1,
    required,
    optional,
    prohibited,
    network: { externalServices: "deny", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  });
  const outcome = resolveEffectivePlan({
    distribution: {
      distributionId: "fuzz",
      descriptors,
      moduleIds: descriptors.flatMap((d) => d.moduleIds),
      cachedCapabilityIds: [],
    },
    instancePolicy: {
      schemaVersion: 1,
      kind: "instance-policy",
      instanceId: "inst-1",
      revision: 1,
      required,
      optional,
      prohibited,
      network: { externalServices: "deny", allowedServiceOrigins: [] },
      updates: {
        unknownCapabilities: "deny",
        expandedExposure: "require-approval",
      },
    },
    runtimeEnvironments: ["document"],
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  });
  if (!validation.ok && outcome.ok) {
    throw new Error("invalid policy resolved to a plan");
  }
  if (outcome.ok) {
    const wanted = new Set([...required, ...optional]);
    for (const c of outcome.plan.selected) {
      if (c.stateAxes.loaded && !wanted.has(c.id)) {
        throw new Error(`fuzz: ${c.id} loaded without being wanted`);
      }
    }
  }
}
