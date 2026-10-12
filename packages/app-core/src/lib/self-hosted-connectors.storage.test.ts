import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import { initialDraftState } from "./connect-draft.js";
import { connectPlan } from "./connect-plan.js";
import { revokeConnection } from "./connections.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import {
  createDeviceConnection,
  sealDeviceConfiguration,
  sealDeviceCredential,
} from "./device-connectors.js";
import * as kv from "./kv.js";
import {
  type SelfHostedConnectorOptions,
  readSelfHostedConnector,
  saveSelfHostedConnectorDurable,
} from "./self-hosted-connectors.js";

const known = connectPlan("linear");
if (!known) throw new Error("Linear plan missing");
const plan = known;
const options: SelfHostedConnectorOptions = {
  mode: "managed",
  workspace: "example",
  appScopes: ["read"],
  userScopes: [],
  webhookResourceTypes: [],
  icon: "",
};
const ATOMIC_KEY = "opensesame.self-hosted-connectors.v1";
function draft(clientId = "client", clientSecret = "secret") {
  const initial = initialDraftState(plan, "oauth");
  return { ...initial, oauth: { ...initial.oauth, clientId, clientSecret } };
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

it("reloads client metadata and credentials from one committed file after each edit", async () => {
  const backend = diskBackend();
  const created = await saveSelfHostedConnectorDurable(plan, draft(), options);
  expect(backend.write).toHaveBeenCalledTimes(1);
  expect([...backend.disk.keys()]).toEqual([ATOMIC_KEY]);
  backend.reload();
  expect(
    readSelfHostedConnector(created.connectionId)?.state.oauth.clientId,
  ).toBe("client");
  expect(readDeviceSecrets()[created.connectionId]).toEqual({
    oauth_client_secret: "secret",
  });
  await saveSelfHostedConnectorDurable(
    plan,
    draft("new-client", "new-secret"),
    options,
    created.connectionId,
  );
  backend.reload();
  expect(
    readSelfHostedConnector(created.connectionId)?.state.oauth.clientId,
  ).toBe("new-client");
  expect(readDeviceSecrets()[created.connectionId]).toEqual({
    oauth_client_secret: "new-secret",
  });
  expect(JSON.stringify(readDeviceRows())).not.toContain("new-secret");
});

it("migrates legacy credentials and prevents generic remove from resurrecting them on reload", async () => {
  const backend = diskBackend();
  const state = draft();
  state.oauth.clientSecret = "";
  const id = "conn_local_legacy";
  const legacy = {
    connectionId: id,
    providerId: plan.id,
    displayName: plan.name,
    scopes: [],
    fields: { self_hosted_configuration: JSON.stringify({ state, options }) },
    createdAt: "2026-10-08",
    updatedAt: "2026-10-08",
  };
  backend.disk.set("opensesame.device-connectors.v1", JSON.stringify([legacy]));
  backend.disk.set(
    "opensesame.device-connector-secrets.v1",
    JSON.stringify({ [id]: { oauth_client_secret: "legacy-secret" } }),
  );
  backend.reload();
  await saveSelfHostedConnectorDurable(plan, state, options, id);
  backend.reload();
  expect(readDeviceRows()).toHaveLength(1);
  expect(readDeviceSecrets()[id]).toEqual({
    oauth_client_secret: "legacy-secret",
  });
  await revokeConnection(id);
  backend.reload();
  expect(readDeviceRows()).toEqual([]);
  expect(readDeviceSecrets()).toEqual({});
  expect(readSelfHostedConnector(id)).toBeNull();
});

it("keeps native connector mutations separate while an atomic edit waits for storage", async () => {
  const saved = await saveSelfHostedConnectorDurable(plan, draft(), options);
  const original = kv.kvSeams.kvSetDurable;
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      entered();
      await gate;
      return original(key, value);
    },
  );
  const update = saveSelfHostedConnectorDurable(
    plan,
    draft("new-client", "new-secret"),
    options,
    saved.connectionId,
  );
  await started;
  const syncWrite = vi.spyOn(kv, "kvSet");
  const native = createDeviceConnection({ providerId: "s3" });
  sealDeviceCredential(native.connectionId, "native-secret");
  expect(
    syncWrite.mock.calls.filter(([key]) => key === ATOMIC_KEY),
  ).toHaveLength(0);
  release();
  await update;
  expect(readDeviceRows()).toHaveLength(2);
  expect(readDeviceSecrets()[saved.connectionId]).toEqual({
    oauth_client_secret: "new-secret",
  });
  expect(readDeviceSecrets()[native.connectionId]).toEqual({
    credential: "native-secret",
  });
  expect(sealDeviceCredential(saved.connectionId, "wrong-secret")).toBeNull();
  expect(
    sealDeviceConfiguration(saved.connectionId, { workspace: "wrong" }),
  ).toBeNull();
});

it("preserves session configuration when OPFS exists but the device key is ephemeral", async () => {
  const originFiles = vi.fn(async () => {
    throw new Error("Disk must not be read");
  });
  configureHost(createTestHost({ atRestKeys: undefined, originFiles }));
  forgetAtRestKeyForTest();
  const first = await saveSelfHostedConnectorDurable(plan, draft(), options);
  const second = await saveSelfHostedConnectorDurable(
    plan,
    draft("second", "second-secret"),
    options,
  );
  expect(readDeviceRows()).toHaveLength(2);
  expect(readDeviceSecrets()[first.connectionId]).toEqual({
    oauth_client_secret: "secret",
  });
  expect(readDeviceSecrets()[second.connectionId]).toEqual({
    oauth_client_secret: "second-secret",
  });
  expect(originFiles).not.toHaveBeenCalled();
});

it("rejects an oversized encoded ledger before committing an unreadable record", async () => {
  const state = draft("client", "é".repeat(17 * 1024 * 1024));
  const write = vi.spyOn(kv.kvSeams, "kvSetDurable");
  await expect(
    saveSelfHostedConnectorDurable(plan, state, options),
  ).rejects.toThrow("storage size limit");
  expect(write).not.toHaveBeenCalled();
  expect(readDeviceRows()).toEqual([]);
});
