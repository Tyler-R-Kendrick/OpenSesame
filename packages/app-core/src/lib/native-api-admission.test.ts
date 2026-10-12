import { expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvSeams } from "./kv.js";
import { nativeApiCleanup } from "./native-api-cleanup.js";
import {
  configureNativeApiConnector,
  executeNativeApiRequest,
  invokeNativeApiConnector,
  verifyNativeApiConnector,
} from "./native-api-connectors.js";
import { nativeApiFingerprint, nativeApiTarget } from "./native-api-target.js";
import {
  installNativeApiTests,
  nativeAnswers,
  nativeApiDraft,
} from "./native-api.test-support.js";
import { nativeBrowserApiPolicy } from "./native-browser-policy.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();
type BlockedCase = { providerId: string; parameters: Record<string, string> };
const blocked: BlockedCase[] = [
  { providerId: "resend", parameters: {} },
  { providerId: "neon", parameters: {} },
  { providerId: "datadog", parameters: {} },
  { providerId: "datadog", parameters: { site: "datadoghq.eu" } },
  { providerId: "typeform", parameters: { api_host: "api.typeform.com" } },
  { providerId: "typeform", parameters: { api_host: "api.eu.typeform.com" } },
  { providerId: "railway", parameters: { credential_variant: "account" } },
  { providerId: "railway", parameters: { credential_variant: "project" } },
  {
    providerId: "railway",
    parameters: {
      credential_variant: "workspace",
      workspace_id: "workspace-1",
    },
  },
];

it("verifies Anthropic with its official browser opt-in before sealing a ready connection", async () => {
  const provider = nativeAnswers({ body: { data: [] } });
  const view = await configureNativeApiConnector(
    nativeApiDraft("anthropic"),
    provider.transport,
  );
  expect(view.status).toBe("connected");
  expect(provider.fetch.mock.calls[0]?.[0].toString()).toBe(
    "https://api.anthropic.com/v1/models",
  );
  const headers = new Headers(provider.fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  expect(headers.get("anthropic-version")).toBe("2023-06-01");
  expect(headers.get("x-api-key")).toBe("private-native-key");
});

it.each(blocked)(
  "refuses browser-blocked $providerId $parameters before credential HTTP or a sealed save",
  async ({ providerId, parameters }) => {
    const provider = nativeAnswers({ body: {} });
    const target = nativeApiTarget(providerId, parameters);
    const policy = nativeBrowserApiPolicy(providerId, target.parameters);
    expect(policy.available).toBe(false);
    await expect(
      configureNativeApiConnector(
        {
          ...nativeApiDraft(providerId),
          parameters,
        },
        provider.transport,
      ),
    ).rejects.toThrow(policy.reason ?? "unavailable");
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(kvSeams.kvSetDurable).not.toHaveBeenCalled();
    expect(readDeviceRows()).toEqual([]);
  },
);

/** Represents a previously verified record saved before the browser refusal was authored. */
async function savedBeforePolicy() {
  const target = nativeApiTarget("resend", {});
  const fingerprint = await nativeApiFingerprint(target);
  const privateState = emptyNativePrivate();
  privateState.credentials = { api_key: "private-native-key" };
  privateState.verification = {
    fingerprint,
    verifiedAt: 100,
    kind: "provider",
  };
  privateState.grants.app = {
    providerId: "resend",
    actor: "app",
    fingerprint,
    kind: "api-key",
    accessToken: "private-native-key",
    targetId: "https://api.resend.com",
    expiresAt: null,
    scopes: null,
  };
  return saveNativeConnector(
    {
      connectionId: "previous-resend",
      configuration: {
        version: 1,
        providerId: "resend",
        method: "api-key",
        displayName: "Old connection",
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: { api: "https://api.resend.com" },
        fingerprint,
      },
      runtime: {
        ...emptyNativeRuntime(),
        verifiedAt: 100,
        grants: [
          {
            actor: "app",
            label: "API key",
            permissionState: "provider-managed",
            grantedScopes: [],
            expiresAt: null,
            needsReauth: false,
          },
        ],
      },
      privateState,
    },
    target.classification,
  );
}

it.each(["verify", "read", "operation"] as const)(
  "blocks an existing browser-refused connection's %s and invalidates proof without losing local cleanup authority",
  async (operation) => {
    const view = await savedBeforePolicy();
    const provider = nativeAnswers({ body: {} });
    const action =
      operation === "verify"
        ? verifyNativeApiConnector(view.connectionId, provider.transport)
        : operation === "read"
          ? invokeNativeApiConnector(
              view.connectionId,
              "provider.read",
              {},
              provider.transport,
            )
          : executeNativeApiRequest(
              view.connectionId,
              {
                providerId: "resend",
                operationId: "provider.read",
                method: "GET",
                path: "/domains",
              },
              {},
              () => "unused",
              provider.transport,
            );
    await expect(action).rejects.toThrow(
      nativeBrowserApiPolicy("resend").reason ?? "unavailable",
    );
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(readNativeConnector(view.connectionId)?.status).toBe("reauthorize");
    const record = loadNativeConnectorRecord(view.connectionId);
    expect(record?.privateState.verification).toBeNull();
    expect(record?.privateState.grants.app?.accessToken).toBe(
      "private-native-key",
    );
    const dispose = registerNativeProviderCleanup("resend", nativeApiCleanup);
    try {
      await expect(
        removeNativeConnectorWithCleanup(view.connectionId),
      ).resolves.toBe(true);
    } finally {
      dispose();
    }
    expect(readNativeConnector(view.connectionId)).toBeNull();
    expect(provider.fetch).not.toHaveBeenCalled();
  },
);

it("does not invalidate a saved proof through a disposed browser runtime", async () => {
  const view = await savedBeforePolicy();
  const provider = nativeAnswers({ body: {} });
  provider.assertCurrent.mockImplementation(() => {
    throw new Error("Capability disposed");
  });
  vi.mocked(kvSeams.kvSetDurable).mockClear();
  await expect(
    verifyNativeApiConnector(view.connectionId, provider.transport),
  ).rejects.toThrow("Capability disposed");
  expect(kvSeams.kvSetDurable).not.toHaveBeenCalled();
  expect(
    loadNativeConnectorRecord(view.connectionId)?.privateState.verification,
  ).not.toBeNull();
});
