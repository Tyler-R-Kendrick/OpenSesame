import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceProviderRevokers } from "./device-connectors.js";
import * as kv from "./kv.js";
import {
  type NativeProviderCleanup,
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  readNativeConnector,
  saveNativeConnector,
} from "./native-connector-store.js";

const disposers: (() => void)[] = [];
const providerId = "cleanup-lifetime";
const fingerprint = "b".repeat(64);
async function saveFixture(): Promise<string> {
  const connectionId = "lifetime-connection";
  await saveNativeConnector(
    {
      connectionId,
      configuration: {
        version: 1,
        providerId,
        method: "api-key",
        displayName: "Lifetime fixture",
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      runtime: {
        ...emptyNativeRuntime(),
        verifiedAt: 100,
        grants: [
          {
            actor: "app",
            label: "Fixture key",
            permissionState: "unknown",
            grantedScopes: [],
            expiresAt: null,
            needsReauth: false,
          },
        ],
      },
      privateState: {
        ...emptyNativePrivate(),
        credentials: { api_key: "private-lifetime-key" },
        verification: { fingerprint, verifiedAt: 100, kind: "provider" },
        grants: {
          app: {
            providerId,
            actor: "app",
            kind: "api-key",
            fingerprint,
            accessToken: "private-lifetime-key",
            expiresAt: null,
            scopes: null,
          },
        },
      },
    },
    { publicParameters: [], privateCredentials: ["api_key"] },
  );
  return connectionId;
}
function adapter(): NativeProviderCleanup {
  return {
    classification: () => ({
      publicParameters: [],
      privateCredentials: ["api_key"],
    }),
    cleanup: vi.fn(async () => "local-credential-forgotten" as const),
  };
}
beforeEach(() => {
  kv.kvForgetAll();
  const memory = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      memory.set(key, value);
    },
  );
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

it.each(["retry", "remove"] as const)(
  "refuses %s queued under a replaced cleanup runtime",
  async (action) => {
    const id = await saveFixture();
    const old = adapter();
    const releaseOld = registerNativeProviderCleanup(providerId, old);
    const pending =
      action === "retry"
        ? retryNativeConnectorCleanup(id)
        : removeNativeConnectorWithCleanup(id);
    releaseOld();
    const fresh = adapter();
    disposers.push(registerNativeProviderCleanup(providerId, fresh));
    await expect(pending).rejects.toThrow("runtime changed");
    expect(fresh.cleanup).not.toHaveBeenCalled();
    expect(old.cleanup).not.toHaveBeenCalled();
    expect(readNativeConnector(id)?.status).toBe("connected");
  },
);

it("a retained old revoker cannot borrow a newly registered provider cleanup", async () => {
  const id = await saveFixture();
  const old = adapter();
  const releaseOld = registerNativeProviderCleanup(providerId, old);
  const revoke = deviceProviderRevokers[providerId];
  if (!revoke) throw new Error("Missing revoker fixture");
  releaseOld();
  const fresh = adapter();
  disposers.push(registerNativeProviderCleanup(providerId, fresh));
  await expect(revoke(id)).rejects.toThrow("runtime changed");
  expect(fresh.cleanup).not.toHaveBeenCalled();
  expect(readNativeConnector(id)?.status).toBe("connected");
});

it("refuses completion when its provider runtime changes while prepare awaits", async () => {
  const id = await saveFixture();
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete = () => {};
  const pendingPrepare = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const old = adapter();
  old.prepare = async () => {
    started();
    await pendingPrepare;
  };
  const releaseOld = registerNativeProviderCleanup(providerId, old);
  const pending = retryNativeConnectorCleanup(id);
  await entered;
  releaseOld();
  const fresh = adapter();
  disposers.push(registerNativeProviderCleanup(providerId, fresh));
  complete();
  await expect(pending).rejects.toThrow("Provider cleanup failed");
  expect(fresh.cleanup).not.toHaveBeenCalled();
  expect(readNativeConnector(id)?.status).toBe("connected");
});
