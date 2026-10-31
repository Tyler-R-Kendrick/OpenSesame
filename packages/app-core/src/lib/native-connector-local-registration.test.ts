import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import * as kv from "./kv.js";
import {
  registerNativeProviderCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  saveNativeConnector,
} from "./native-connector-store.js";

const fingerprint = "c".repeat(64);
const classification = { publicParameters: [], privateCredentials: [] };
const configuration = {
  version: 1 as const,
  providerId: "cleanup-example",
  method: "oauth" as const,
  displayName: "Cleanup example",
  icon: "",
  parameters: {},
  requestedScopes: {},
  targetIds: {},
  fingerprint,
};
let dispose = () => {};
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
  configureHost(createTestHost());
});
afterEach(() => {
  dispose();
  vi.restoreAllMocks();
});
it.each(["revoke", "configure"] as const)(
  "does not discharge %s as a local registration",
  async (kind) => {
    const saved = await saveNativeConnector(
      {
        connectionId: "local-registration-test",
        configuration,
        runtime: emptyNativeRuntime(),
        privateState: {
          ...emptyNativePrivate(),
          recovery: [
            {
              id: "unresolved",
              kind,
              providerId: configuration.providerId,
              actor: "user",
              fingerprint,
              targetId: configuration.providerId,
            },
          ],
        },
      },
      classification,
    );
    dispose = registerNativeProviderCleanup(configuration.providerId, {
      classification: () => classification,
      cleanup: async () => "local-registration-forgotten",
    });
    await expect(
      retryNativeConnectorCleanup(saved.connectionId),
    ).rejects.toThrow("Provider cleanup failed");
    expect(
      loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery.map(
        (entry) => entry.id,
      ),
    ).toEqual(["unresolved"]);
  },
);
