/** @vitest-environment jsdom */
/**
 * RELOAD_REQUIRED at the loader (carried from #470's restart-required rule):
 * a capability that must start in a fresh document, approved after this one
 * has run other modules, stays approved and is refused before any import
 * until a reload. What the document approved while still clean starts even
 * when the plan is resolved again after other modules have run — a vault
 * opening mid-boot must not strand it.
 */

import {
  type CapabilityCatalog,
  type CapabilityDescriptor,
  type DistributionContract,
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION_ID,
  type RuntimeHandle,
  buildConsentReceipt,
  exposureDigest,
  fixtureResolveInput,
  resolveComposition,
} from "@opensesame/capability-composition";
import { beforeEach, describe, expect, it } from "vitest";
import { NOW, bootPersonalLocal, freshRealm } from "./__tests__/harness.js";
import { evaluatedModuleIds } from "./facts.js";
import {
  activateApprovedCapability,
  loadApprovedModule,
  loaderSeams,
} from "./loader.js";
import type { CapabilityModule } from "./runtime-contract.js";
import { storeSeams } from "./store-seams.js";
import { compositionStore } from "./store.js";

const PASSKEYS = "vault.passkey-records";
// A document-only capability that must start in a fresh document, as
// WebMCP's registration with the browser does.
const WEBMCP = "agents.webmcp";

function reloading(): CapabilityDescriptor {
  const declared = {
    ...FIXTURE_CATALOG.capabilities[0],
    id: WEBMCP,
    tier: "optional",
    title: "WebMCP tools",
    operationIds: [],
    moduleIds: [`${WEBMCP}/runtime`],
    itemKinds: [],
    keyAccess: "none",
    requiresDocumentReload: true,
  } satisfies Omit<CapabilityDescriptor, "exposureDigest">;
  return { ...declared, exposureDigest: exposureDigest(declared) };
}

const CATALOG: CapabilityCatalog = {
  ...FIXTURE_CATALOG,
  capabilities: [...FIXTURE_CATALOG.capabilities, reloading()],
};

const DISTRIBUTION: DistributionContract = {
  ...FIXTURE_DISTRIBUTION,
  capabilityIds: [...FIXTURE_DISTRIBUTION.capabilityIds, WEBMCP],
  moduleIds: [...FIXTURE_DISTRIBUTION.moduleIds, `${WEBMCP}/runtime`],
};

function inertModule(capability: string): () => Promise<CapabilityModule> {
  return async () => ({
    capabilityRuntime: {
      capability,
      async activate(): Promise<RuntimeHandle> {
        return { capability, dispose: () => undefined };
      },
    },
  });
}

let imports: string[] = [];

function installTable(): void {
  imports = [];
  loaderSeams.moduleTable = async () =>
    Object.fromEntries(
      [PASSKEYS, WEBMCP].map((id) => [
        `${id}/runtime`,
        () => {
          imports.push(id);
          return inertModule(id)();
        },
      ]),
    );
}

async function commit(selected: readonly string[], revision: string) {
  const plan = compositionStore.getSnapshot().plan;
  if (!plan) throw new Error("store not resolved");
  const draft = {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: plan.identity.instanceId,
    installationId: FIXTURE_INSTALLATION_ID,
    basePolicyRevision: plan.identity.policyRevision,
    revision,
    acceptedRequired: [],
    selectedOptional: [...selected],
    chosenAlternatives: {},
    delivery: { prefetch: "none", offlineCache: "shell-only" },
  } as const;
  const candidate = resolveComposition(
    fixtureResolveInput({
      catalog: CATALOG,
      distribution: DISTRIBUTION,
      installation: draft,
      facts: { ...FIXTURE_FACTS, now: NOW },
    }),
  );
  const receipt = buildConsentReceipt(candidate, CATALOG, NOW);
  const outcome = await compositionStore.commit(draft, receipt);
  if (outcome.status !== "committed") throw new Error(outcome.status);
}

function webmcpState() {
  return compositionStore.getSnapshot().plan?.capabilities[WEBMCP];
}

beforeEach(() => {
  freshRealm();
  storeSeams.catalog = async () => CATALOG;
  storeSeams.distribution = async () => DISTRIBUTION;
  installTable();
});

describe("RELOAD_REQUIRED at the loader", () => {
  it("approved after another module ran: waits for a reload, refused before import", async () => {
    await bootPersonalLocal(compositionStore);
    await commit([PASSKEYS], "r1");
    await activateApprovedCapability(PASSKEYS, compositionStore.currentLease());
    expect(evaluatedModuleIds()).toEqual([`${PASSKEYS}/runtime`]);

    await commit([PASSKEYS, WEBMCP], "r2");
    expect(webmcpState()?.approved).toBe(true);
    expect(webmcpState()?.reasons).toEqual(["RELOAD_REQUIRED"]);
    expect(compositionStore.getSnapshot().lifecycle[WEBMCP]).toBe(
      "reload-required",
    );
    await expect(
      activateApprovedCapability(WEBMCP, compositionStore.currentLease()),
    ).rejects.toMatchObject({
      name: "CapabilityDenied",
      code: "RELOAD_REQUIRED",
    });
    expect(imports).toEqual([PASSKEYS]);
  });

  it("loadApprovedModule refuses its module too, whoever asks, before any import", async () => {
    await bootPersonalLocal(compositionStore);
    await commit([PASSKEYS], "r1");
    await activateApprovedCapability(PASSKEYS, compositionStore.currentLease());
    await commit([PASSKEYS, WEBMCP], "r2");
    await expect(
      loadApprovedModule(`${WEBMCP}/runtime`, compositionStore.currentLease()),
    ).rejects.toMatchObject({ code: "RELOAD_REQUIRED" });
    expect(imports).toEqual([PASSKEYS]);
  });

  it("approved while the document was clean: still starts after a later resolve", async () => {
    await bootPersonalLocal(compositionStore);
    await commit([PASSKEYS, WEBMCP], "r1");
    await activateApprovedCapability(PASSKEYS, compositionStore.currentLease());
    // A re-resolve after another module ran, before this one started.
    compositionStore.onVaultChange("vault-a");
    expect(webmcpState()?.reasons).toEqual([]);
    const handles = await activateApprovedCapability(
      WEBMCP,
      compositionStore.currentLease(),
    );
    expect(handles).toHaveLength(1);
    expect(imports).toEqual([PASSKEYS, WEBMCP]);
  });

  it("a fresh document owes nothing", async () => {
    await bootPersonalLocal(compositionStore);
    await commit([WEBMCP], "r1");
    expect(webmcpState()?.reasons).toEqual([]);
    expect(compositionStore.getSnapshot().lifecycle[WEBMCP]).not.toBe(
      "reload-required",
    );
  });
});
