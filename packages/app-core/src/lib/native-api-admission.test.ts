import { expect, it, vi } from "vitest";
import { aiHttpFixture } from "./ai-connections/protocol.test-support.js";
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

async function providerHttp(status: number | "network") {
  const fixture = await aiHttpFixture((_request, response) => {
    if (status === "network") response.destroy();
    else {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ username: "Fixture operator" }));
    }
  });
  const provider = nativeAnswers();
  provider.fetch.mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The real logical provider request reaches an owned HTTP protocol oracle.
    return fetch(
      new URL(url.pathname + url.search, new URL(fixture.baseUrl).origin),
      init,
    );
  });
  return { ...provider, fixture };
}

it.each(
  blocked.flatMap((entry) =>
    ["network", 401].map((failure) => ({ ...entry, failure })),
  ),
)(
  "$providerId $parameters attempts HTTP and refuses $failure without a connected record",
  async ({ providerId, parameters, failure }) => {
    const provider = await providerHttp(
      failure === "network" ? "network" : 401,
    );
    try {
      const target = nativeApiTarget(providerId, parameters);
      expect(
        nativeBrowserApiPolicy(providerId, target.parameters).available,
      ).toBe(true);
      await expect(
        configureNativeApiConnector(
          {
            ...nativeApiDraft(providerId),
            parameters,
            credentials: Object.fromEntries(
              target.classification.privateCredentials.map((key) => [
                key,
                "private-native-key",
              ]),
            ),
          },
          provider.transport,
        ),
      ).rejects.toThrow(
        failure === "network"
          ? "Could not reach the provider"
          : "Provider authorization was refused",
      );
      expect(provider.fetch).toHaveBeenCalledOnce();
      expect(provider.fixture.requests).toHaveLength(1);
      expect(kvSeams.kvSetDurable).not.toHaveBeenCalled();
      expect(readDeviceRows()).toEqual([]);
    } finally {
      await provider.fixture.close();
    }
  },
);

it("actually verifies the Replicate account instead of treating historical CORS evidence as a refusal", async () => {
  const provider = await providerHttp(200);
  try {
    const view = await configureNativeApiConnector(
      nativeApiDraft("replicate"),
      provider.transport,
    );
    expect(view.status).toBe("connected");
    expect(provider.fixture.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/account",
    });
    expect(provider.fixture.requests[0]?.headers.authorization).toBe(
      "Bearer private-native-key",
    );
    expect(readDeviceRows()).toHaveLength(1);
  } finally {
    await provider.fixture.close();
  }
});

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
        targets: [{ id: "https://api.resend.com", label: "API", kind: "api" }],
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
  "invalidates an existing connection after actual401 on %s without losing local cleanup authority",
  async (operation) => {
    const view = await savedBeforePolicy();
    const provider = await providerHttp(401);
    try {
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
        "Provider authorization was refused",
      );
      expect(provider.fetch).toHaveBeenCalledOnce();
      expect(provider.fixture.requests).toHaveLength(1);
      expect(readNativeConnector(view.connectionId)?.status).toBe(
        "reauthorize",
      );
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
      expect(provider.fetch).toHaveBeenCalledOnce();
    } finally {
      await provider.fixture.close();
    }
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
