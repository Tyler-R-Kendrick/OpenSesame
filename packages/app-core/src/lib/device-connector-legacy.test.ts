import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configureHost } from "../host.js";
import { createNodeHost } from "../node/host.js";
import {
  LEGACY_CONNECTOR_PUBLIC_KEY as PUBLIC_KEY,
  LEGACY_CONNECTOR_SECRET_KEY as SECRET_KEY,
} from "./device-connector-legacy-storage.js";
import {
  refreshLegacyDeviceConnectorStatus,
  resolveLegacyDeviceConnectors,
} from "./device-connector-legacy.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import { runListedFeature } from "./feature-connector-operation.js";
import { kvFlush, kvForgetAll, kvGet, kvHydrate, kvSetDurable } from "./kv.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { vaultStore } from "./vault/store.js";
import { tombFileKey } from "./vfs.js";
const PASSWORD = "real-legacy-resolution-owner-password";
const A = "conn_local_unbound_a";
const B = "conn_local_unbound_b";
const proof = {
  tomb: "personal",
  currentPassword: PASSWORD,
  acknowledgeOwnershipAmbiguity: true as const,
};
async function withLegacy(work: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "connector-legacy-recovery-"));
  configureHost(createNodeHost({ stateDir: directory }));
  vaultStore.loadActiveProjectScope();
  try {
    await vaultStore.create(PASSWORD);
    const stamp = new Date().toISOString();
    await kvSetDurable(
      PUBLIC_KEY,
      JSON.stringify(
        [A, B].map((connectionId) => ({
          connectionId,
          providerId: "anthropic",
          displayName: connectionId,
          scopes: [],
          fields: {},
          createdAt: stamp,
          updatedAt: stamp,
        })),
      ),
    );
    await kvSetDurable(
      SECRET_KEY,
      JSON.stringify({
        [A]: { credential: "legacy-a-key" },
        [B]: { credential: "legacy-b-key" },
      }),
    );
    await work();
  } finally {
    vaultStore.lock();
    await kvFlush();
    kvForgetAll();
    await rm(directory, { recursive: true, force: true });
  }
}
it("requires fresh correct member proof and deliberately resolves only selected legacy credentials", async () => {
  await withLegacy(async () => {
    const status = await refreshLegacyDeviceConnectorStatus("personal");
    expect(status.records.map((row) => row.connectionId)).toEqual([A, B]);
    expect(JSON.stringify(status)).not.toContain("legacy-a-key");
    await expect(
      resolveLegacyDeviceConnectors({
        ...proof,
        currentPassword: "incorrect-password",
        decision: "import",
        connectionIds: [A],
      }),
    ).rejects.toThrow();
    expect(readDeviceSecrets()[A]).toBeUndefined();
    expect(kvGet(SECRET_KEY)).toContain("legacy-a-key");
    await resolveLegacyDeviceConnectors({
      ...proof,
      decision: "import",
      connectionIds: [A],
    });
    expect(readDeviceSecrets()[A]?.credential).toBe("legacy-a-key");
    const run = runListedFeature("anthropic");
    expect(run.ok && run.secrets.credential).toBe("legacy-a-key");
    expect(kvGet(SECRET_KEY)).not.toContain("legacy-a-key");
    expect(kvGet(SECRET_KEY)).toContain("legacy-b-key");
    expect(
      (await refreshLegacyDeviceConnectorStatus("personal")).records.map(
        (row) => row.connectionId,
      ),
    ).toEqual([B]);
    await resolveLegacyDeviceConnectors({
      ...proof,
      decision: "discard",
      connectionIds: [B],
    });
    expect((await refreshLegacyDeviceConnectorStatus("personal")).pending).toBe(
      false,
    );
    vaultStore.lock();
    await vaultStore.unlock(PASSWORD);
    expect(readDeviceSecrets()[A]?.credential).toBe("legacy-a-key");
    expect(readDeviceSecrets()[B]).toBeUndefined();
  });
});
it("cold authoritative trap enrollment detects persisted unbound secrets and guest cannot resolve them", async () => {
  await withLegacy(async () => {
    await vaultStore.flushPendingWrites();
    vaultStore.lock();
    kvForgetAll();
    await kvHydrate(
      ["header", "body", "index", "migrated.v1", "seal-bound.v1"].map((path) =>
        tombFileKey("personal", path),
      ),
    );
    vaultStore.rehydrate();
    await vaultStore.unlock(PASSWORD);
    expect(kvGet(SECRET_KEY)).toBeNull();
    await expect(
      enrollRetiredCredential({
        tomb: "personal",
        currentPassword: PASSWORD,
        retiredPassword: "chosen-retired-password",
        acknowledgePasswordVerifierRisk: true,
      }),
    ).rejects.toThrow("Resolve legacy connector credentials");
    expect(kvGet(SECRET_KEY)).toContain("legacy-a-key");
    vaultStore.lock();
    await vaultStore.createGuest({ resume: false });
    expect(() =>
      resolveLegacyDeviceConnectors({
        ...proof,
        decision: "discard",
        connectionIds: [A],
      }),
    ).toThrow();
    expect(readDeviceSecrets()).toEqual({});
    expect(kvGet(SECRET_KEY)).toContain("legacy-a-key");
  });
});

it("a failed actual root body write retains the legacy source and permits an exact-owner retry", async () => {
  await withLegacy(async () => {
    const { vfsSeams } = await import("./vfs.js");
    const write = vfsSeams.writeRaw;
    let fail = true;
    vfsSeams.writeRaw = async (key, value) => {
      if (fail && key === tombFileKey("personal", "body")) {
        fail = false;
        throw new Error("Actual storage fault at the body write boundary");
      }
      await write(key, value);
    };
    try {
      await expect(
        resolveLegacyDeviceConnectors({
          ...proof,
          decision: "import",
          connectionIds: [A],
        }),
      ).rejects.toThrow("storage fault");
      expect(kvGet(SECRET_KEY)).toContain("legacy-a-key");
      await resolveLegacyDeviceConnectors({
        ...proof,
        decision: "import",
        connectionIds: [A],
      });
      expect(readDeviceSecrets()[A]?.credential).toBe("legacy-a-key");
      expect(kvGet(SECRET_KEY)).not.toContain("legacy-a-key");
      expect(kvGet(SECRET_KEY)).toContain("legacy-b-key");
    } finally {
      vfsSeams.writeRaw = write;
    }
  });
});
it("orphan discard and explicitly acknowledged corrupt-map recovery preserve owned credentials", async () => {
  await withLegacy(async () => {
    const { discardIrrecoverableLegacyConnectorSecrets } = await import(
      "./device-connector-legacy.js"
    );
    const { createDeviceConnection, sealDeviceCredential } = await import(
      "./device-connectors.js"
    );
    const owner = await createDeviceConnection({ providerId: "azure-openai" });
    await sealDeviceCredential(owner.connectionId, "current-root-owned-key");
    await kvSetDurable(
      PUBLIC_KEY,
      JSON.stringify(
        JSON.parse(kvGet(PUBLIC_KEY) ?? "[]").filter(
          (row: { connectionId: string }) => row.connectionId !== B,
        ),
      ),
    );
    const status = await refreshLegacyDeviceConnectorStatus("personal");
    expect(
      status.records.find((row) => row.connectionId === B)?.providerId,
    ).toBe("unbound");
    await expect(
      resolveLegacyDeviceConnectors({
        ...proof,
        decision: "import",
        connectionIds: [B],
      }),
    ).rejects.toThrow("no recoverable configuration");
    await resolveLegacyDeviceConnectors({
      ...proof,
      decision: "discard",
      connectionIds: [B],
    });
    expect(kvGet(SECRET_KEY)).toContain("legacy-a-key");
    expect(kvGet(SECRET_KEY)).not.toContain("legacy-b-key");
    await kvSetDurable(SECRET_KEY, "{corrupt legacy map");
    expect(
      (await refreshLegacyDeviceConnectorStatus("personal")).available,
    ).toBe(false);
    await expect(
      discardIrrecoverableLegacyConnectorSecrets({
        tomb: "personal",
        currentPassword: "incorrect-password",
        acknowledgeIrrecoverableLegacyDiscard: true,
      }),
    ).rejects.toThrow();
    expect(kvGet(SECRET_KEY)).toBe("{corrupt legacy map");
    const publicBefore = kvGet(PUBLIC_KEY);
    await discardIrrecoverableLegacyConnectorSecrets({
      tomb: proof.tomb,
      currentPassword: proof.currentPassword,
      acknowledgeIrrecoverableLegacyDiscard: true,
    });
    expect(kvGet(PUBLIC_KEY)).toBe(publicBefore);
    expect(readDeviceSecrets()[owner.connectionId]?.credential).toBe(
      "current-root-owned-key",
    );
    expect((await refreshLegacyDeviceConnectorStatus("personal")).pending).toBe(
      false,
    );
  });
});
