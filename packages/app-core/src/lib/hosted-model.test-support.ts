/** Test-only verified native model fixtures; no real provider authorization. */
import { afterEach, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import {
  type HostedModelConnection,
  bindHostedModelAuthority,
} from "./hosted-model-authority.js";
import { isHostedModelProvider } from "./hosted-model-protocol.js";
import * as kv from "./kv.js";
import { executeNativeApiRequest } from "./native-api-operations.js";
import { nativeApiFingerprint, nativeApiTarget } from "./native-api-target.js";
import { emptyNativePrivate } from "./native-connector-schema.js";
import { readNativeConnector } from "./native-connector-store.js";
import { saveNativeConnector } from "./native-connector-store.js";
export const MODEL_TEST_SECRET = "private-model-test-credential";
const authorityReleases: (() => void)[] = [];
afterEach(() => {
  for (const release of authorityReleases.splice(0)) release();
});
function modelView(id: string): HostedModelConnection | null {
  const view = readNativeConnector(id);
  return view
    ? {
        connectionId: id,
        providerId: view.providerId,
        status: view.status,
        method: view.configuration.method,
      }
    : null;
}
export function bindModelFixtureAuthority(): void {
  authorityReleases.push(
    bindHostedModelAuthority({
      fetch: async () => {
        throw new Error("Fixture requires an explicit transport");
      },
      assertCurrent() {},
      read: modelView,
      connections: () =>
        readDeviceRows().flatMap((row) => {
          const view = modelView(row.connectionId);
          return view ? [view] : [];
        }),
      execute: (id, definition, body, project, fence) =>
        executeNativeApiRequest(id, definition, body, project, fence),
    }),
  );
}
export function modelMemoryBackend(bindAuthority = true): void {
  if (bindAuthority) bindModelFixtureAuthority();
  const memory = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => memory.get(key) ?? null,
  );
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      memory.set(key, value);
    },
  );
}
export async function saveModelFixture(
  providerId: string,
  verified = true,
  id = providerId,
): Promise<string> {
  const fingerprint = isHostedModelProvider(providerId)
    ? await nativeApiFingerprint(nativeApiTarget(providerId, {}))
    : "a".repeat(64);
  const privateState = emptyNativePrivate();
  privateState.credentials = { api_key: MODEL_TEST_SECRET };
  if (verified) {
    privateState.verification = {
      fingerprint,
      verifiedAt: 100,
      kind: "provider",
    };
    privateState.grants.app = {
      providerId,
      actor: "app",
      kind: "api-key",
      fingerprint,
      accessToken: MODEL_TEST_SECRET,
      scopes: null,
      expiresAt: null,
    };
  }
  await saveNativeConnector(
    {
      connectionId: id,
      configuration: {
        version: 1,
        providerId,
        method: "api-key",
        displayName: "Model",
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      privateState,
      runtime: {
        verifiedAt: verified ? 100 : null,
        identity: null,
        targets: [],
        grants: verified
          ? [
              {
                actor: "app",
                label: "Key",
                permissionState: "provider-managed",
                grantedScopes: [],
                expiresAt: null,
                needsReauth: false,
              },
            ]
          : [],
      },
    },
    { publicParameters: [], privateCredentials: ["api_key"] },
  );
  return id;
}
