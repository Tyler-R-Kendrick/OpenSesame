import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { readDeviceRows } from "./device-connector-records.js";
import * as kv from "./kv.js";
import {
  type NativeConfiguration,
  type NativePrivateState,
  type NativeRuntime,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  removeNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Fixture value missing");
  return value;
}

const fingerprint = "a".repeat(64);
const classification = {
  publicParameters: ["region"],
  privateCredentials: ["key", "clientSecret"],
};
const configuration: NativeConfiguration = {
  version: 1,
  providerId: "example",
  method: "api-key",
  displayName: "Example connection",
  icon: "",
  parameters: { region: "us" },
  requestedScopes: {},
  targetIds: {},
  fingerprint,
};
function authority(): NativePrivateState {
  return {
    ...emptyNativePrivate(),
    credentials: { key: "private-key" },
    grants: {
      user: {
        providerId: "example",
        actor: "user",
        kind: "api-key",
        fingerprint,
        accessToken: "private-key",
        scopes: null,
        expiresAt: null,
      },
    },
    verification: { fingerprint, verifiedAt: 100, kind: "provider" },
  };
}
function runtime(): NativeRuntime {
  return {
    verifiedAt: 100,
    identity: {
      id: "account-1",
      label: "Acme",
      kind: "account",
      assurance: "account-verified",
    },
    targets: [],
    grants: [
      {
        actor: "user",
        label: "Provider key",
        permissionState: "provider-managed",
        grantedScopes: [],
        expiresAt: null,
        needsReauth: false,
      },
    ],
  };
}
function input(id = "native-1") {
  return {
    connectionId: id,
    configuration: structuredClone(configuration),
    privateState: authority(),
    runtime: runtime(),
  };
}
function diskBackend() {
  const disk = new Map<string, string>();
  const memory = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  const write = vi
    .spyOn(kv.kvSeams, "kvSetDurable")
    .mockImplementation(async (key, value) => {
      disk.set(key, value);
      memory.set(key, value);
    });
  return {
    disk,
    memory,
    write,
    reload: () => {
      memory.clear();
      for (const [key, value] of disk) memory.set(key, value);
    },
  };
}
beforeEach(kv.kvForgetAll);
afterEach(() => {
  vi.restoreAllMocks();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});

it("commits verified facts and private authority atomically and exposes no credentials after reload", async () => {
  const backend = diskBackend();
  const saved = await saveNativeConnector(input(), classification);
  expect(saved.status).toBe("connected");
  expect(backend.write).toHaveBeenCalledTimes(1);
  backend.reload();
  expect(readNativeConnector(saved.connectionId)).toEqual(saved);
  expect(JSON.stringify(readDeviceRows())).not.toContain("private-key");
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    "private-key",
  );
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.credentials,
  ).toEqual({ key: "private-key" });
});

it("refuses secret and unknown public parameters before a disk write", async () => {
  const backend = diskBackend();
  for (const parameter of ["clientSecret", "unknown"]) {
    const record = input();
    record.configuration.parameters[parameter] = "do-not-publish";
    await expect(saveNativeConnector(record, classification)).rejects.toThrow(
      "public provider field",
    );
  }
  expect(backend.write).not.toHaveBeenCalled();
  expect(readDeviceRows()).toEqual([]);
});

it("never activates metadata without a sealed verification proof or bound grant", async () => {
  diskBackend();
  const noProof = input("no-proof");
  noProof.privateState.verification = null;
  expect((await saveNativeConnector(noProof, classification)).status).toBe(
    "configuration",
  );
  const noGrant = input("no-grant");
  noGrant.privateState.grants = {};
  expect((await saveNativeConnector(noGrant, classification)).status).toBe(
    "configuration",
  );
  const inventedPermissions = input("invented-permissions");
  required(inventedPermissions.runtime.grants[0]).grantedScopes = [
    "chosen-scope",
  ];
  expect(
    (await saveNativeConnector(inventedPermissions, classification)).status,
  ).toBe("configuration");
});

it("distinguishes companion configuration from a proven browser-local operation", async () => {
  diskBackend();
  const record = input("local-configuration");
  record.configuration.method = "native-local";
  record.privateState.grants = {};
  record.runtime.grants = [];
  required(record.privateState.verification).kind = "configuration";
  expect((await saveNativeConnector(record, classification)).status).toBe(
    "configuration",
  );
  record.connectionId = "local-operation";
  required(record.privateState.verification).kind = "browser-local";
  expect((await saveNativeConnector(record, classification)).status).toBe(
    "connected",
  );
});

it("retains the previous committed record when saving or rotating fails", async () => {
  const backend = diskBackend();
  const saved = await saveNativeConnector(input(), classification);
  backend.write.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    updateNativeConnector(
      saved.connectionId,
      saved,
      classification,
      (record) => {
        required(record.privateState.grants.user).accessToken =
          "rotated-private-key";
        return record;
      },
    ),
  ).rejects.toThrow("disk full");
  backend.reload();
  expect(readNativeConnector(saved.connectionId)?.revision).toBe(1);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants.user
      ?.accessToken,
  ).toBe("private-key");
});

it("returns the committed snapshot even if a caller edits its input while storage waits", async () => {
  const backend = diskBackend();
  const durable = backend.write.getMockImplementation();
  if (!durable) throw new Error("Missing durable fixture");
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  backend.write.mockImplementation(async (key, value) => {
    entered();
    await gate;
    return durable(key, value);
  });
  const record = input();
  const saving = saveNativeConnector(record, classification);
  await started;
  record.configuration.displayName = "Uncommitted edit";
  record.privateState.verification = null;
  release();
  const saved = await saving;
  backend.reload();
  expect(saved.status).toBe("connected");
  expect(saved.configuration.displayName).toBe("Example connection");
  expect(readNativeConnector(saved.connectionId)).toEqual(saved);
});

it("rechecks concurrent rotations under the shared lock and preserves the winner", async () => {
  const backend = diskBackend();
  const locks = webLocksDouble();
  configureHost(createTestHost({ locks: overlapCast(locks) }));
  const saved = await saveNativeConnector(input(), classification);
  const rotate = (token: string) =>
    updateNativeConnector(
      saved.connectionId,
      saved,
      classification,
      (record) => {
        required(record.privateState.grants.user).accessToken = token;
        const proof = required(record.privateState.verification);
        record.privateState.verification = {
          kind: proof.kind,
          verifiedAt: proof.verifiedAt,
          fingerprint: proof.fingerprint,
        };
        return record;
      },
    );
  const results = await Promise.allSettled([rotate("first"), rotate("second")]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  backend.reload();
  expect(locks.peak()).toBe(1);
  expect(locks.requested).toEqual([
    "opensesame:device-connectors",
    "opensesame:device-connectors",
    "opensesame:device-connectors",
  ]);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants.user
      ?.accessToken,
  ).toBe("first");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("reauthorize");
});

it("refuses stale deletion and unfinished cleanup then persists a guarded tombstone", async () => {
  const backend = diskBackend();
  const saved = await saveNativeConnector(input(), classification);
  await expect(
    removeNativeConnector(saved.connectionId, saved),
  ).rejects.toThrow("cleanup must finish");
  const cleared = await updateNativeConnector(
    saved.connectionId,
    saved,
    classification,
    (record) => ({
      ...record,
      runtime: emptyNativeRuntime(),
      privateState: emptyNativePrivate(),
    }),
  );
  await expect(
    removeNativeConnector(saved.connectionId, saved),
  ).rejects.toThrow("changed");
  expect(await removeNativeConnector(saved.connectionId, cleared)).toBe(true);
  backend.reload();
  expect(readNativeConnector(saved.connectionId)).toBeNull();
});

it("keeps exact old authorization cleanup bindings without falsely activating", async () => {
  diskBackend();
  const record = input();
  record.privateState.recovery.push({
    id: "cleanup-1",
    kind: "revoke",
    providerId: "example",
    actor: "user",
    fingerprint: "b".repeat(64),
    targetId: "old-workspace",
    grant: {
      ...required(authority().grants.user),
      fingerprint: "b".repeat(64),
      targetId: "old-workspace",
      accessToken: "old-private-token",
    },
  });
  const saved = await saveNativeConnector(record, classification);
  expect(saved.status).toBe("cleanup");
  expect(saved.recovery[0]?.kind).toBe("revoke");
  expect(JSON.stringify(saved)).not.toContain("old-private-token");
  expect(JSON.stringify(saved)).not.toContain("old-workspace");
});

it("marks expired grants for reauthorization and rejects identity changes under the same binding", async () => {
  diskBackend();
  const record = input();
  required(record.runtime.grants[0]).expiresAt = 1;
  required(record.privateState.grants.user).expiresAt = 1;
  const saved = await saveNativeConnector(record, classification);
  expect(saved.status).toBe("reauthorize");
  await expect(
    updateNativeConnector(
      saved.connectionId,
      saved,
      classification,
      (current) => {
        required(current.runtime.identity).id = "different-account";
        return current;
      },
    ),
  ).rejects.toThrow("identity changed");
});

it("does not treat requested permissions as granted permissions", async () => {
  diskBackend();
  const record = input();
  record.configuration.requestedScopes = { user: ["admin"] };
  const metadata = required(record.runtime.grants[0]);
  metadata.permissionState = "known";
  metadata.grantedScopes = ["read"];
  required(record.privateState.grants.user).scopes = ["read"];
  expect((await saveNativeConnector(record, classification)).status).toBe(
    "reauthorize",
  );
});

it("sanitizes invalid sealed records instead of returning parser messages or credentials", async () => {
  const backend = diskBackend();
  await saveNativeConnector(input(), classification);
  const key = "opensesame.self-hosted-connectors.v1";
  const packed = backend.memory.get(key);
  if (!packed) throw new Error("Missing fixture ledger");
  backend.memory.set(key, packed.replace("private-key", "invalid"));
  const corrupted = loadNativeConnectorRecord("native-1");
  expect(corrupted?.privateState.credentials.key).toBe("invalid");
  backend.memory.set(
    key,
    packed.replace('"native_authority":"', '"native_authority":"bad'),
  );
  expect(() => readNativeConnector("native-1")).toThrow(
    "Saved native connector is invalid",
  );
});
