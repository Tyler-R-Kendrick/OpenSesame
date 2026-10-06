import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createNodeHost } from "../node/host.js";
import {
  activeDeviceConnectorPrincipal,
  assertDeviceConnectorPrincipal,
  requireDeviceConnectorPrincipal,
} from "./device-connector-principal.js";
import * as connectorRecords from "./device-connector-records.js";
import {
  readDeviceRows,
  readDeviceSecrets,
  writeDeviceSecrets,
} from "./device-connector-records.js";
import {
  createDeviceConnection,
  forgetDeviceConnectors,
  sealDeviceCredential,
} from "./device-connectors.js";
import { runListedFeature } from "./feature-connector-operation.js";
import { kvFlush, kvForgetAll, kvGet, kvHydrate, kvSet } from "./kv.js";
import { verifyCurrentCredential } from "./retired-credentials/owner-auth.js";
import { vaultStore } from "./vault/store.js";
import { tombStorageKeys } from "./vault/tomb-migration.js";
const PASSWORD = "actual-connector-owner-password";

it("refuses a completed predecessor metadata operation before dispatching secrets into a successor owner", async () => {
  await runWithDevice(async () => {
    await vaultStore.create(PASSWORD);
    const first = await createDeviceConnection({ providerId: "anthropic" });
    await sealDeviceCredential(first.connectionId, "predecessor-key");
    let reached = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutate = connectorRecords.mutateDeviceRows;
    const held = vi
      .spyOn(connectorRecords, "mutateDeviceRows")
      .mockImplementationOnce(async (change) => {
        const rows = await mutate(change);
        reached();
        await blocked;
        return rows;
      });
    const pending = sealDeviceCredential(
      first.connectionId,
      "predecessor-carried-key",
    ).then(
      () => null,
      (error: Error) => error,
    );
    try {
      await started;
      vaultStore.lock();
      await vaultStore.createGuest({ resume: false });
      await vaultStore.enrollPassword("actual-successor-owner-password");
      const second = await createDeviceConnection({ providerId: "anthropic" });
      await connectorRecords.writeDeviceRows(
        readDeviceRows().map((row) => ({
          ...row,
          connectionId:
            row.connectionId === second.connectionId
              ? first.connectionId
              : row.connectionId,
        })),
      );
      await sealDeviceCredential(first.connectionId, "successor-owner-key");
      const original = vaultStore.getSnapshot().items;
      release();
      expect.soft(await pending).toBeInstanceOf(Error);
      expect(readDeviceSecrets()[first.connectionId]?.credential).toBe(
        "successor-owner-key",
      );
      expect(vaultStore.getSnapshot().items).toEqual(original);
    } finally {
      release();
      await pending;
      held.mockRestore();
    }
  });
});

it("changing one connector writes only its bound secret and preserves unrelated root items", async () => {
  await runWithDevice(async () => {
    await vaultStore.create(PASSWORD);
    const first = await createDeviceConnection({ providerId: "anthropic" });
    const second = await createDeviceConnection({ providerId: "openai" });
    await sealDeviceCredential(first.connectionId, "untouched-key");
    await sealDeviceCredential(second.connectionId, "original-key");
    const firstId = readDeviceRows().find(
      (row) => row.connectionId === first.connectionId,
    )?.secretItemId;
    const original = vaultStore
      .getSnapshot()
      .items.find((item) => item.id === firstId);
    const saved = vi.spyOn(vaultStore, "saveItem");
    try {
      await sealDeviceCredential(second.connectionId, "replacement-key");
      expect(saved).toHaveBeenCalledTimes(1);
      expect(
        vaultStore.getSnapshot().items.find((item) => item.id === firstId),
      ).toEqual(original);
      expect(readDeviceSecrets()[first.connectionId]?.credential).toBe(
        "untouched-key",
      );
      expect(readDeviceSecrets()[second.connectionId]?.credential).toBe(
        "replacement-key",
      );
      saved.mockClear();
      await writeDeviceSecrets({ [second.connectionId]: {} });
      expect(saved).toHaveBeenCalledTimes(1);
      expect(readDeviceSecrets()[second.connectionId]).toEqual({});
      expect(readDeviceSecrets()[first.connectionId]?.credential).toBe(
        "untouched-key",
      );
    } finally {
      saved.mockRestore();
    }
  });
});

it("a committed password change admits only the new password before and after cold hydration", async () => {
  await runWithDevice(async () => {
    await vaultStore.create(PASSWORD);
    const connection = await createDeviceConnection({
      providerId: "anthropic",
    });
    await sealDeviceCredential(connection.connectionId, "rekey-preserved-key");
    const next = "actual-new-connector-owner-password";
    await vaultStore.changeMasterPassword(PASSWORD, next, "changed hint");
    await kvFlush();
    await expect(
      verifyCurrentCredential("personal", next),
    ).resolves.toBeUndefined();
    await expect(
      verifyCurrentCredential("personal", PASSWORD),
    ).rejects.toThrow();
    vaultStore.lock();
    kvForgetAll();
    await kvHydrate([
      ...tombStorageKeys("personal"),
      "opensesame.device-connectors.v1",
    ]);
    vaultStore.rehydrate();
    await expect(vaultStore.unlock(PASSWORD)).rejects.toThrow();
    await vaultStore.unlock(next);
    expect(readDeviceSecrets()[connection.connectionId]?.credential).toBe(
      "rekey-preserved-key",
    );
  });
});
async function runWithDevice(work: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "connector-owned-records-"));
  configureHost(createNodeHost({ stateDir: directory }));
  vaultStore.loadActiveProjectScope();
  try {
    await work();
  } finally {
    vaultStore.lock();
    await kvFlush();
    kvForgetAll();
    await rm(directory, { recursive: true, force: true });
  }
}

it("guest updates and clearing preserve member-owned records and quarantine unbound history", async () => {
  await runWithDevice(async () => {
    const legacy = {
      connectionId: "conn_local_legacy",
      providerId: "anthropic",
      displayName: "Legacy unbound",
      scopes: [],
      fields: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    kvSet("opensesame.device-connectors.v1", JSON.stringify([legacy]));
    kvSet(
      "opensesame.device-connector-secrets.v1",
      JSON.stringify({
        [legacy.connectionId]: { credential: "legacy-unbound-key" },
      }),
    );
    await vaultStore.create(PASSWORD);
    const owner = await createDeviceConnection({ providerId: "anthropic" });
    await sealDeviceCredential(owner.connectionId, "actual-member-key");
    expect(readDeviceSecrets()[owner.connectionId]?.credential).toBe(
      "actual-member-key",
    );
    expect(
      readDeviceRows().some((row) => row.connectionId === legacy.connectionId),
    ).toBe(false);
    expect(kvGet("opensesame.device-connector-secrets.v1")).not.toContain(
      "actual-member-key",
    );
    vaultStore.lock();
    expect(activeDeviceConnectorPrincipal()).toBeNull();
    expect(() => createDeviceConnection({ providerId: "anthropic" })).toThrow();
    await vaultStore.createGuest({ resume: false });
    const guest = await createDeviceConnection({ providerId: "anthropic" });
    await sealDeviceCredential(guest.connectionId, "guest-key");
    expect(readDeviceSecrets()[guest.connectionId]?.credential).toBe(
      "guest-key",
    );
    expect(readDeviceSecrets()[owner.connectionId]).toBeUndefined();
    const guestSecretId = readDeviceRows().find(
      (row) => row.connectionId === guest.connectionId,
    )?.secretItemId;
    await forgetDeviceConnectors();
    expect(
      vaultStore.getSnapshot().items.find((item) => item.id === guestSecretId)
        ?.deletedAt,
    ).toEqual(expect.any(String));
    expect(readDeviceRows()).toEqual([]);
    expect(kvGet("opensesame.device-connectors.v1")).toContain(
      legacy.connectionId,
    );
    vaultStore.lock();
    vaultStore.loadActiveProjectScope();
    await vaultStore.unlock(PASSWORD);
    expect(readDeviceSecrets()[owner.connectionId]?.credential).toBe(
      "actual-member-key",
    );
    expect(readDeviceSecrets()[legacy.connectionId]).toBeUndefined();
  });
});

it("explicit guest enrollment carries only the guest's body-bound connector to stable member ownership", async () => {
  await runWithDevice(async () => {
    await vaultStore.createGuest({ resume: false });
    const original = requireDeviceConnectorPrincipal();
    const guest = await createDeviceConnection({ providerId: "anthropic" });
    await sealDeviceCredential(guest.connectionId, "guest-carried-key");
    await vaultStore.enrollPassword(PASSWORD);
    const member = requireDeviceConnectorPrincipal();
    expect(member.kind).toBe("member");
    expect(member.id).not.toBe(original.id);
    expect(readDeviceRows()[0]?.owner).toBe(member.id);
    const run = runListedFeature("anthropic");
    expect(run.ok && run.secrets.credential).toBe("guest-carried-key");
    vaultStore.lock();
    expect(readDeviceSecrets()).toEqual({});
    await vaultStore.unlock(PASSWORD);
    expect(requireDeviceConnectorPrincipal().id).toBe(member.id);
    expect(readDeviceSecrets()[guest.connectionId]?.credential).toBe(
      "guest-carried-key",
    );
    expect(() => assertDeviceConnectorPrincipal(member)).toThrow();
  });
});

it("a substituted secret item cannot supply or receive connector credentials", async () => {
  await runWithDevice(async () => {
    const { createItem } = await import("@opensesame/vault-core");
    const { writeDeviceRows } = await import("./device-connector-records.js");
    await vaultStore.create(PASSWORD);
    const connection = await createDeviceConnection({
      providerId: "anthropic",
    });
    await sealDeviceCredential(connection.connectionId, "bound-connector-key");
    const rows = readDeviceRows();
    const unrelated = createItem("secret", "Unrelated owner secret");
    unrelated.value = "unrelated-owner-data";
    await vaultStore.addItems([unrelated]);
    await writeDeviceRows(
      rows.map((row) => ({ ...row, secretItemId: unrelated.id })),
    );
    expect(readDeviceSecrets()[connection.connectionId]).toBeUndefined();
    await expect(
      sealDeviceCredential(connection.connectionId, "replacement-key"),
    ).rejects.toThrow();
    expect(
      vaultStore.getSnapshot().items.find((item) => item.id === unrelated.id),
    ).toMatchObject({ value: "unrelated-owner-data" });
    await writeDeviceRows(rows);
    expect(readDeviceSecrets()[connection.connectionId]?.credential).toBe(
      "bound-connector-key",
    );
  });
});
