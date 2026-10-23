import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { kvSeams } from "./kv.js";
import {
  configureNativeApiConnector,
  executeNativeApiRequest,
  invokeNativeApiConnector,
  testNativeApiCredential,
} from "./native-api-connectors.js";
import {
  installNativeApiTests,
  nativeAnswers,
  nativeApiDraft,
} from "./native-api.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();
describe("provider-verified sealed native API connections", () => {
  it("does not expose a decoder error that includes credential-bearing provider data", async () => {
    const provider = nativeAnswers(
      { body: { data: [] } },
      { body: { token: "private-native-key" } },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft("openai"),
      provider.transport,
    );
    const result = executeNativeApiRequest(
      view.connectionId,
      {
        providerId: "openai",
        operationId: "model.generate",
        method: "POST",
        path: "/v1/chat/completions",
      },
      {},
      (body) => {
        throw new Error(JSON.stringify(body));
      },
      provider.transport,
    );
    await expect(result).rejects.toMatchObject({
      code: "response",
      message: "Provider did not return the expected response",
    });
  });
  it.each([
    [
      "asana",
      "https://app.asana.com/api/1.0/users/me",
      { data: { name: "Ada" } },
    ],
    ["attio", "https://api.attio.com/v2/objects", { data: [] }],
  ])(
    "connects %s with its own PAT and verifies the provider identity",
    async (providerId, url, body) => {
      const provider = nativeAnswers({ body });
      const view = await configureNativeApiConnector(
        nativeApiDraft(providerId),
        provider.transport,
      );
      expect(view.status).toBe("connected");
      expect(view.identity?.assurance).toBe("credential-valid");
      expect(provider.fetch.mock.calls[0]?.[0].toString()).toBe(url);
      expect(
        new Headers(provider.fetch.mock.calls[0]?.[1]?.headers).get(
          "authorization",
        ),
      ).toBe("Bearer private-native-key");
    },
  );

  it("actually verifies, stores one private key, and awaits a real read without exposing upstream secrets", async () => {
    const provider = nativeAnswers(
      {
        body: {
          id: "bot-1",
          name: "Team integration",
          leaked: "private-native-key",
        },
      },
      {
        body: {
          id: "bot-1",
          name: "Team integration",
          token: "private-native-key",
        },
      },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    expect(view.status).toBe("connected");
    expect(view.identity?.assurance).toBe("credential-valid");
    expect(JSON.stringify(view)).not.toContain("private-native-key");
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "private-native-key",
    );
    expect(
      loadNativeConnectorRecord(view.connectionId)?.privateState.credentials
        .api_key,
    ).toBe("private-native-key");
    expect(provider.fetch.mock.calls[0]?.[0].toString()).toBe(
      "https://api.notion.com/v1/users/me",
    );
    expect(
      new Headers(provider.fetch.mock.calls[0]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer private-native-key");
    const result = await invokeNativeApiConnector(
      view.connectionId,
      "provider.read",
      {},
      provider.transport,
    );
    expect(result).toEqual({ label: "Team integration", items: [] });
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { body: { error: "private-native-key" }, status: 401 },
    { body: { name: "reflected private-native-key" }, status: 200 },
  ])(
    "refuses unauthorized or credential-reflecting verification %j",
    async (reply) => {
      const provider = nativeAnswers(reply);
      await expect(
        configureNativeApiConnector(nativeApiDraft(), provider.transport),
      ).rejects.toThrow();
      expect(readDeviceRows()).toEqual([]);
    },
  );

  it("requires actual provider success and account fields without inventing scope or workspace proof", async () => {
    const provider = nativeAnswers({ body: { success: false } }, { body: {} });
    await expect(
      configureNativeApiConnector(
        nativeApiDraft("firecrawl"),
        provider.transport,
      ),
    ).rejects.toMatchObject({ code: "authorization" });
    await expect(
      configureNativeApiConnector(
        nativeApiDraft("deepseek"),
        provider.transport,
      ),
    ).rejects.toMatchObject({ code: "response" });
    expect(readDeviceRows()).toEqual([]);
  });

  it("retains blank credentials only for the exact target and marks actual 401 pending", async () => {
    const provider = nativeAnswers(
      { body: { name: "Team" } },
      { body: { name: "Team" } },
      { body: {}, status: 401 },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    const renamed = await configureNativeApiConnector(
      {
        ...nativeApiDraft(),
        connectionId: view.connectionId,
        revision: view.revision,
        displayName: "Renamed",
        credentials: { api_key: "" },
        targetIds: { api: "https://api.notion.com" },
      },
      provider.transport,
    );
    expect(renamed.status).toBe("connected");
    await expect(
      invokeNativeApiConnector(
        view.connectionId,
        "provider.read",
        {},
        provider.transport,
      ),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(readNativeConnector(view.connectionId)?.status).toBe("reauthorize");
    await expect(
      invokeNativeApiConnector(
        view.connectionId,
        "provider.read",
        {},
        provider.transport,
      ),
    ).rejects.toThrow("Verify");
    expect(provider.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not claim a verified save when the encrypted durable write fails", async () => {
    const provider = nativeAnswers({ body: { name: "Team" } });
    vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Encrypted write failed"),
    );
    await expect(
      configureNativeApiConnector(nativeApiDraft(), provider.transport),
    ).rejects.toThrow("Encrypted write failed");
    expect(readDeviceRows()).toEqual([]);
  });

  it("projects a trusted fixed model request and rejects reflected key text before returning", async () => {
    const provider = nativeAnswers(
      { body: { data: [] } },
      { body: { text: "answer", token: "private-native-key" } },
      { body: { text: "reflected private-native-key" } },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft("openai"),
      provider.transport,
    );
    const definition = {
      providerId: "openai",
      operationId: "model.generate",
      method: "POST" as const,
      path: "/v1/chat/completions",
    };
    const project = (body: BoundaryValue) => {
      if (!isJsonObject(body) || !isString(body.text))
        throw new Error("Expected answer");
      return body.text;
    };
    expect(
      await executeNativeApiRequest(
        view.connectionId,
        definition,
        { messages: [] },
        project,
        provider.transport,
      ),
    ).toBe("answer");
    await expect(
      executeNativeApiRequest(
        view.connectionId,
        definition,
        {},
        project,
        provider.transport,
      ),
    ).rejects.toMatchObject({ code: "response" });
    await expect(
      executeNativeApiRequest(
        view.connectionId,
        { ...definition, origin: "https://evil.test" },
        {},
        project,
        provider.transport,
      ),
    ).rejects.toThrow("compiled target");
    expect(provider.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("testing a key without saving it (ADR 0192)", () => {
  const draft = () => {
    const { providerId, parameters, credentials } = nativeApiDraft("openai");
    return { providerId, parameters, credentials };
  };

  it("asks the provider's list route with the key and keeps nothing", async () => {
    const provider = nativeAnswers({ body: { data: [] } });
    const answer = await testNativeApiCredential(draft(), provider.transport);
    expect(answer.label).toBeTruthy();
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(provider.fetch.mock.calls[0]?.[0].toString()).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(
      new Headers(provider.fetch.mock.calls[0]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer private-native-key");
    expect(readDeviceRows()).toHaveLength(0);
    expect(JSON.stringify(answer)).not.toContain("private-native-key");
  });

  it("says a key the provider refuses is refused, and still keeps nothing", async () => {
    const provider = nativeAnswers({
      status: 401,
      body: { error: { message: "private-native-key is not valid" } },
    });
    const refused = await testNativeApiCredential(
      draft(),
      provider.transport,
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused?.message).not.toContain("private-native-key");
    expect(readDeviceRows()).toHaveLength(0);
  });

  it("makes no request for a provider the catalog does not know", async () => {
    const provider = nativeAnswers({ body: { data: [] } });
    await expect(
      testNativeApiCredential(
        { ...draft(), providerId: "no-such-provider" },
        provider.transport,
      ),
    ).rejects.toThrow();
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("stops when the capability that owns the transport has ended", async () => {
    const provider = nativeAnswers({ body: { data: [] } });
    provider.assertCurrent.mockImplementation(() => {
      throw new Error("lease ended");
    });
    await expect(
      testNativeApiCredential(draft(), provider.transport),
    ).rejects.toThrow("lease ended");
    expect(provider.fetch).not.toHaveBeenCalled();
  });
});
