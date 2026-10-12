import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { deviceProviderRevokers } from "./device-connectors.js";
import * as kv from "./kv.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  type NativeConfiguration,
  type NativeGrant,
  emptyNativePrivate,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";

const fingerprint = "c".repeat(64);
const classification = {
  publicParameters: [],
  privateCredentials: ["clientSecret", "otherSecret"],
};
const disposers: (() => void)[] = [];
const configuration: NativeConfiguration = {
  version: 1,
  providerId: "cleanup-example",
  method: "oauth",
  displayName: "Cleanup example",
  icon: "",
  parameters: {},
  requestedScopes: { user: ["read"] },
  targetIds: {},
  fingerprint,
};
const grant: NativeGrant = {
  providerId: configuration.providerId,
  actor: "user",
  fingerprint,
  kind: "oauth",
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: null,
  scopes: ["read"],
  issuer: "https://example.org",
  clientId: "public-client",
  targetId: "workspace-1",
};
async function save(connectionId = "lifecycle-1") {
  return saveNativeConnector(
    {
      connectionId,
      configuration: structuredClone(configuration),
      runtime: {
        verifiedAt: 100,
        identity: null,
        targets: [],
        grants: [
          {
            actor: "user",
            label: "User",
            permissionState: "known",
            grantedScopes: ["read"],
            expiresAt: null,
            needsReauth: false,
          },
        ],
      },
      privateState: {
        ...emptyNativePrivate(),
        credentials: {
          clientSecret: "private-client",
          otherSecret: "other-private",
        },
        grants: { user: structuredClone(grant) },
        verification: { fingerprint, verifiedAt: 100, kind: "provider" },
      },
    },
    classification,
  );
}
function backend() {
  const memory = new Map<string, string>();
  const disk = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  const write = vi
    .spyOn(kv.kvSeams, "kvSetDurable")
    .mockImplementation(async (key, value) => {
      memory.set(key, value);
      disk.set(key, value);
    });
  return {
    write,
    reload: () => {
      memory.clear();
      for (const [key, value] of disk) memory.set(key, value);
    },
  };
}
beforeEach(kv.kvForgetAll);
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});

it("refuses removal without a concrete provider cleanup adapter", async () => {
  backend();
  const saved = await save();
  await expect(
    removeNativeConnectorWithCleanup(saved.connectionId),
  ).rejects.toThrow("cleanup is unavailable");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
});

it("journals before provider cleanup and keeps selected credentials sealed after failure", async () => {
  const disk = backend();
  const saved = await save();
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      credentialSlots: ["clientSecret"],
      cleanup: async (obligation) => {
        expect(
          loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery,
        ).toEqual([obligation]);
        expect(obligation.targetId).toBe("workspace-1");
        expect(obligation.credentials).toEqual({
          clientSecret: "private-client",
        });
        throw new Error("upstream-private-error");
      },
    }),
  );
  await expect(
    removeNativeConnectorWithCleanup(saved.connectionId),
  ).rejects.toThrow("Provider cleanup failed; retry");
  disk.reload();
  expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    "private-client",
  );
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants,
  ).toEqual({});
});

it("dispatches the exact connection and seals rotation before revocation and removal", async () => {
  const disk = backend();
  const first = await save("first");
  const second = await save("second");
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      cleanup: async (obligation, context) => {
        expect(context.connectionId).toBe(first.connectionId);
        if (!obligation.grant) throw new Error("Missing grant");
        const { accessToken: previousAccessToken, ...binding } =
          obligation.grant;
        expect(previousAccessToken).toBe("private-access");
        await context.persistGrantRotation({
          accessToken: "rotated-access",
          ...binding,
          refreshToken: "rotated-refresh",
        });
        disk.reload();
        expect(
          loadNativeConnectorRecord(first.connectionId)?.privateState
            .recovery[0]?.grant?.accessToken,
        ).toBe("rotated-access");
        return "provider-revoked";
      },
    }),
  );
  const revoke = deviceProviderRevokers[configuration.providerId];
  if (!revoke) throw new Error("Missing revoker");
  await revoke(first.connectionId);
  disk.reload();
  expect(readNativeConnector(first.connectionId)).toBeNull();
  expect(readNativeConnector(second.connectionId)?.status).toBe("connected");
});

it("retains the rotated cleanup grant when the completion write fails", async () => {
  const disk = backend();
  const saved = await save();
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      cleanup: async (obligation, context) => {
        if (!obligation.grant) throw new Error("Missing grant");
        await context.persistGrantRotation({
          ...obligation.grant,
          accessToken: "rotated-access",
        });
        disk.write.mockRejectedValueOnce(new Error("disk full"));
        return "provider-revoked";
      },
    }),
  );
  await expect(
    removeNativeConnectorWithCleanup(saved.connectionId),
  ).rejects.toThrow("Provider cleanup failed");
  disk.reload();
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery[0]
      ?.grant?.accessToken,
  ).toBe("rotated-access");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
});

it("cannot forget fresh authorization appearing during provider cleanup", async () => {
  backend();
  const saved = await save();
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      cleanup: async () => {
        const current = readNativeConnector(saved.connectionId);
        if (!current) throw new Error("Missing connector");
        await updateNativeConnector(
          saved.connectionId,
          current,
          classification,
          (record) => {
            record.privateState.grants.user = {
              ...grant,
              accessToken: "concurrent-private",
            };
            return record;
          },
        );
        return "provider-revoked";
      },
    }),
  );
  await expect(
    removeNativeConnectorWithCleanup(saved.connectionId),
  ).rejects.toThrow("authorization changed");
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants.user
      ?.accessToken,
  ).toBe("concurrent-private");
});

it("retains configure obligations until provider-owned reconciliation finishes", async () => {
  backend();
  const saved = await save();
  await updateNativeConnector(
    saved.connectionId,
    saved,
    classification,
    (record) => {
      record.privateState.recovery.push({
        id: "exchange",
        kind: "configure",
        providerId: configuration.providerId,
        actor: "user",
        fingerprint,
        targetId: "workspace-1",
      });
      return record;
    },
  );
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      cleanup: async () => {
        throw new Error("Exchange requires reconciliation");
      },
    }),
  );
  await expect(retryNativeConnectorCleanup(saved.connectionId)).rejects.toThrow(
    "cleanup failed",
  );
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery[0]?.id,
  ).toBe("exchange");
});

it("seals retained issued grants before reading the cleanup snapshot", async () => {
  backend();
  const saved = await save();
  await updateNativeConnector(
    saved.connectionId,
    saved,
    classification,
    (record) => {
      record.privateState.recovery.push({
        id: "retained-exchange",
        kind: "configure",
        providerId: configuration.providerId,
        actor: "user",
        fingerprint,
        targetId: "workspace-1",
      });
      return record;
    },
  );
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      prepare: async (connectionId) => {
        const current = readNativeConnector(connectionId);
        if (!current) throw new Error("Missing connector");
        await updateNativeConnector(
          connectionId,
          current,
          classification,
          (record) => {
            record.privateState.recovery = record.privateState.recovery.map(
              (entry) => ({
                ...entry,
                grant: { ...grant, accessToken: "retained-issued" },
              }),
            );
            return record;
          },
        );
      },
      cleanup: async (obligation) => {
        expect(obligation.grant?.accessToken).toBe("retained-issued");
        return "provider-revoked";
      },
    }),
  );
  await retryNativeConnectorCleanup(saved.connectionId);
  expect(readNativeConnector(saved.connectionId)?.recovery).toEqual([]);
});

it("selects original method credential slots instead of copying other private fields", async () => {
  backend();
  const saved = await save();
  const mcpClassification = {
    publicParameters: [],
    privateCredentials: ["mcp_client", "mcp_target", "clientSecret"],
  };
  await updateNativeConnector(
    saved.connectionId,
    saved,
    mcpClassification,
    (record) => {
      record.configuration.method = "mcp";
      record.privateState.credentials = {
        mcp_client: "sealed-client",
        mcp_target: "sealed-target",
        clientSecret: "unrelated-secret",
      };
      record.privateState.grants.user = {
        ...grant,
        kind: "mcp",
        endpoint: "https://example.org/mcp",
        resource: "https://example.org/mcp",
      };
      return record;
    },
  );
  disposers.push(
    registerNativeProviderCleanup(configuration.providerId, {
      classification: () => mcpClassification,
      credentialSlots: (_configuration, original) =>
        original?.kind === "mcp"
          ? ["mcp_client", "mcp_target"]
          : ["clientSecret"],
      cleanup: async (obligation) => {
        expect(obligation.grant?.kind).toBe("mcp");
        expect(obligation.credentials).toEqual({
          mcp_client: "sealed-client",
          mcp_target: "sealed-target",
        });
        return "local-credential-forgotten";
      },
    }),
  );
  expect(await removeNativeConnectorWithCleanup(saved.connectionId)).toBe(true);
});
