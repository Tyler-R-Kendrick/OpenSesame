import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DistributionContract } from "@opensesame/capability-composition";
import { overlapCast } from "@opensesame/os-domain";
import { composeHost, configureHost, host } from "../../host.js";
import { createNodeHost } from "../../node/host.js";
import type { AuthenticatorPort } from "../../ports.js";
import { CAPABILITY_CATALOG } from "../capabilities/catalog.js";
import { collectRuntimeFacts } from "../capabilities/facts.js";
import { presetById, presetToInstancePolicy } from "../capabilities/presets.js";
import { compositionStore } from "../capabilities/store.js";
import { kvFlush, kvForgetAll } from "../kv.js";
import { writeLastVaultId } from "../last-vault.js";
import { enrollRetiredCredential } from "../retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "../retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "../retired-credentials/unlock.js";
import { parseRuntimeConfig } from "../runtime-config.js";
import { vaultStore } from "../vault/store.js";
import { PERSONAL_TOMB } from "../vfs.js";

export const OWNER_PASSWORD = "backup PRF real encrypted owner fixture";
export const RETIRED_PASSWORD = "backup PRF retired synthetic fixture";
export const RELAY = "https://backup-relay.example.test";
export type OwnerTransition = "lock" | "synthetic" | "fresh-owner";

export function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

/** Real storage, KDF, owner admission, locks and production policy resolver. */
export async function encryptedOwner(authenticator?: AuthenticatorPort) {
  const originalHost = host();
  vaultStore.lock();
  await flushRetiredCredentialTelemetry();
  await kvFlush();
  kvForgetAll();
  compositionStore.resetForTest();
  const directory = await mkdtemp(join(tmpdir(), "backup-prf-owner-"));
  const node = createNodeHost({
    stateDir: directory,
    env: { VITE_CONNECT_CALLBACK_BASE: RELAY },
  });
  const distribution: DistributionContract = {
    distributionId: "backup-prf-owner-integration",
    mode: "selective",
    capabilityIds: CAPABILITY_CATALOG.capabilities.map((row) => row.id),
    moduleIds: [
      ...new Set(
        CAPABILITY_CATALOG.capabilities.flatMap((row) => row.moduleIds),
      ),
    ],
    workerVariants: [],
    basePath: "/",
  };
  configureHost(
    composeHost(node, {
      env: node.env,
      ...(authenticator ? { authenticator } : {}),
      capabilities: {
        distribution: async () => distribution,
        moduleTable: async () => {
          throw new Error(
            "This owner behavior suite does not activate shell modules",
          );
        },
      },
    }),
  );
  writeLastVaultId(PERSONAL_TOMB);
  vaultStore.rehydrate();
  await vaultStore.create(OWNER_PASSWORD);
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  await vaultStore.unlock(OWNER_PASSWORD);
  await enrollRetiredCredential({
    tomb: PERSONAL_TOMB,
    currentPassword: OWNER_PASSWORD,
    retiredPassword: RETIRED_PASSWORD,
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  return {
    async policy(allowedServiceOrigins = [RELAY], prohibited = false) {
      const base = presetToInstancePolicy(
        presetById("homelab"),
        "backup-prf-owner",
        "1",
      );
      const policy = {
        ...base,
        network: { externalServices: "allow", allowedServiceOrigins },
        capabilities: {
          ...base.capabilities,
          prohibited: prohibited
            ? [...base.capabilities.prohibited, "backup.git-remote"]
            : base.capabilities.prohibited,
        },
      };
      await compositionStore.boot({
        runtimeConfig: parseRuntimeConfig(
          overlapCast({
            capabilityComposition: { schemaVersion: 1, instancePolicy: policy },
          }),
        ),
        vaultId: PERSONAL_TOMB,
        facts: collectRuntimeFacts({
          activeWorkerVariant: null,
          now: new Date().toISOString(),
        }),
      });
    },
    async transition(kind: OwnerTransition) {
      vaultStore.lock();
      if (kind === "lock") return;
      await unlockWithRetiredCredentialGate(vaultStore, RETIRED_PASSWORD);
      if (kind === "synthetic") return;
      vaultStore.lock();
      await flushRetiredCredentialTelemetry();
      await vaultStore.unlock(OWNER_PASSWORD);
    },
    async recoverOwner() {
      vaultStore.lock();
      await flushRetiredCredentialTelemetry();
      await vaultStore.unlock(OWNER_PASSWORD);
    },
    async close() {
      await flushRetiredCredentialTelemetry();
      vaultStore.lock();
      await kvFlush();
      kvForgetAll();
      compositionStore.resetForTest();
      configureHost(originalHost);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
