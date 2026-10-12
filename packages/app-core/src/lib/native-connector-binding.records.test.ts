import { beforeEach, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvForgetAll } from "./kv.js";
import {
  type NativeRecovery,
  NativeRuntimeSchema,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";

const fingerprint = "d".repeat(64);
function obligation(): NativeRecovery {
  return {
    id: "exact-cleanup",
    kind: "revoke",
    providerId: "example",
    actor: "user",
    fingerprint,
    targetId: "workspace-1",
    issuer: "https://issuer.example.org",
    resource: "https://mcp.example.org",
    endpoint: "https://mcp.example.org/mcp",
    clientId: "public-client",
    grant: {
      kind: "mcp",
      providerId: "example",
      actor: "user",
      fingerprint,
      targetId: "workspace-1",
      issuer: "https://issuer.example.org",
      resource: "https://mcp.example.org",
      endpoint: "https://mcp.example.org/mcp",
      clientId: "public-client",
      accessToken: "private-token",
      expiresAt: null,
      scopes: null,
    },
  };
}
function save(recovery: NativeRecovery[]) {
  return saveNativeConnector(
    {
      connectionId: "binding-example",
      configuration: {
        version: 1,
        providerId: "example",
        method: "mcp",
        displayName: "Example",
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      runtime: emptyNativeRuntime(),
      privateState: { ...emptyNativePrivate(), recovery },
    },
    { publicParameters: [], privateCredentials: [] },
  );
}
beforeEach(kvForgetAll);

it("refuses duplicate obligation IDs so completion cannot erase a different live grant", async () => {
  const second = obligation();
  if (!second.grant) throw new Error("Missing fixture grant");
  second.grant.accessToken = "another-private-token";
  await expect(save([obligation(), second])).rejects.toThrow(
    "Duplicate provider cleanup obligation",
  );
  expect(readDeviceRows()).toEqual([]);
});

it.each(["issuer", "resource", "endpoint", "clientId"] as const)(
  "refuses an outer %s that conflicts with its grant",
  async (field) => {
    const entry = obligation();
    entry[field] = "conflicting-provider-binding";
    await expect(save([entry])).rejects.toThrow("does not match its audience");
    expect(readDeviceRows()).toEqual([]);
  },
);

it("requires a complete MCP audience even for a private cleanup grant", async () => {
  const entry = obligation();
  if (!entry.grant) throw new Error("Missing fixture grant");
  entry.grant.resource = undefined;
  entry.resource = undefined;
  await expect(save([entry])).rejects.toThrow("missing its audience binding");
  expect(readDeviceRows()).toEqual([]);
});

it("refuses duplicate public actors that could otherwise conceal a sealed actor needing verification", () => {
  const grant = {
    actor: "user",
    label: "User grant",
    permissionState: "unknown",
    grantedScopes: [],
    expiresAt: null,
    needsReauth: false,
  };
  expect(() =>
    NativeRuntimeSchema.parse({
      ...emptyNativeRuntime(),
      grants: [grant, grant],
    }),
  ).toThrow("Duplicate public provider actor");
});

it("preserves the verified identity binding after a token proof is invalidated", async () => {
  const saved = await save([]);
  const classification = { publicParameters: [], privateCredentials: [] };
  const verified = await updateNativeConnector(
    saved.connectionId,
    saved,
    classification,
    (record) => {
      record.runtime.identity = {
        id: "account-original",
        label: "Original",
        kind: "account",
        assurance: "account-verified",
      };
      record.runtime.verifiedAt = 100;
      record.privateState.verification = {
        fingerprint,
        verifiedAt: 100,
        kind: "provider",
      };
      return record;
    },
  );
  const invalidated = await updateNativeConnector(
    saved.connectionId,
    verified,
    classification,
    (record) => {
      record.privateState.verification = null;
      record.runtime.verifiedAt = null;
      return record;
    },
  );
  await expect(
    updateNativeConnector(
      saved.connectionId,
      invalidated,
      classification,
      (record) => {
        record.runtime.identity = {
          id: "account-other",
          label: "Other",
          kind: "account",
          assurance: "account-verified",
        };
        record.runtime.verifiedAt = 200;
        record.privateState.verification = {
          fingerprint,
          verifiedAt: 200,
          kind: "provider",
        };
        return record;
      },
    ),
  ).rejects.toThrow("Verified identity changed");
});
