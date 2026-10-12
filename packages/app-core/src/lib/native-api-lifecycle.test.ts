import { describe, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { nativeApiCleanup } from "./native-api-cleanup.js";
import {
  configureNativeApiConnector,
  executeNativeApiRequest,
  invokeNativeApiConnector,
  verifyNativeApiConnector,
} from "./native-api-connectors.js";
import { nativeApiHttp } from "./native-api-http.js";
import { nativeApiTarget } from "./native-api-target.js";
import {
  installNativeApiTests,
  nativeAnswers,
  nativeApiDraft,
} from "./native-api.test-support.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();
function deferredProvider() {
  let resolve: (response: Response) => void = () => {
    throw new Error("Provider has not started");
  };
  let started: () => void = () => undefined;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    started();
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  let active = true;
  const transport = {
    fetch,
    assertCurrent: () => {
      if (!active) throw new Error("Capability disposed");
    },
  };
  return {
    ready,
    transport,
    dispose: () => {
      active = false;
    },
    answer: () =>
      resolve(new Response(JSON.stringify({ name: "Late provider" }))),
  };
}
describe("native API authority and cancellation", () => {
  it("invalidates the old proof when an edit retaining that exact key gets a provider authorization failure", async () => {
    const provider = nativeAnswers(
      { body: { name: "Team" } },
      { body: {}, status: 401 },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    await expect(
      configureNativeApiConnector(
        {
          ...nativeApiDraft(),
          connectionId: view.connectionId,
          revision: view.revision,
          displayName: "Renamed",
          credentials: { api_key: "" },
        },
        provider.transport,
      ),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(readNativeConnector(view.connectionId)?.status).toBe("reauthorize");
    expect(
      readNativeConnector(view.connectionId)?.configuration.displayName,
    ).toBe("Team API");
  });
  it("preserves an existing verified key when verification of a supplied replacement key fails", async () => {
    const provider = nativeAnswers(
      { body: { name: "Team" } },
      { body: {}, status: 401 },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    await expect(
      configureNativeApiConnector(
        {
          ...nativeApiDraft(),
          connectionId: view.connectionId,
          revision: view.revision,
          credentials: { api_key: "private-invalid-replacement" },
        },
        provider.transport,
      ),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(readNativeConnector(view.connectionId)?.status).toBe("connected");
    expect(
      loadNativeConnectorRecord(view.connectionId)?.privateState.credentials
        .api_key,
    ).toBe("private-native-key");
  });
  it("preserves provider cleanup obligations when verification is attempted during recovery", async () => {
    const provider = nativeAnswers({ body: { name: "Team" } });
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    const classification = nativeApiTarget("notion", {}).classification;
    await updateNativeConnector(
      view.connectionId,
      { revision: view.revision, fingerprint: view.fingerprint },
      classification,
      (record) => {
        const grant = record.privateState.grants.app;
        if (!grant?.targetId) throw new Error("Expected bound grant");
        record.privateState.recovery.push({
          id: "revoke:app",
          kind: "revoke",
          providerId: "notion",
          actor: "app",
          fingerprint: view.fingerprint,
          targetId: grant.targetId,
          grant,
        });
        return record;
      },
    );
    await expect(
      verifyNativeApiConnector(view.connectionId, provider.transport),
    ).rejects.toThrow("cleanup");
    await expect(
      invokeNativeApiConnector(
        view.connectionId,
        "provider.read",
        {},
        provider.transport,
      ),
    ).rejects.toThrow("Verify");
    expect(
      loadNativeConnectorRecord(view.connectionId)?.privateState.recovery,
    ).toHaveLength(1);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["configuration-proof", "expired-grant", "wrong-key"] as const)(
    "refuses a saved %s before API or model HTTP",
    async (condition) => {
      const provider = nativeAnswers({ body: { data: [] } });
      const view = await configureNativeApiConnector(
        nativeApiDraft("openai"),
        provider.transport,
      );
      await updateNativeConnector(
        view.connectionId,
        { revision: view.revision, fingerprint: view.fingerprint },
        nativeApiTarget("openai", {}).classification,
        (record) => {
          const grant = record.privateState.grants.app;
          const proof = record.privateState.verification;
          if (!grant || !proof) throw new Error("Expected verified grant");
          proof.verifiedAt += 1;
          record.runtime.verifiedAt = proof.verifiedAt;
          if (condition === "configuration-proof") proof.kind = "configuration";
          if (condition === "expired-grant") {
            grant.expiresAt = Date.now() - 1;
            for (const metadata of record.runtime.grants)
              metadata.expiresAt = grant.expiresAt;
          }
          if (condition === "wrong-key")
            grant.accessToken = "private-other-key";
          return record;
        },
      );
      await expect(
        invokeNativeApiConnector(
          view.connectionId,
          "provider.read",
          {},
          provider.transport,
        ),
      ).rejects.toThrow("Verify");
      await expect(
        executeNativeApiRequest(
          view.connectionId,
          {
            providerId: "openai",
            operationId: "model.generate",
            method: "POST",
            path: "/v1/chat/completions",
          },
          {},
          () => "answer",
          provider.transport,
        ),
      ).rejects.toThrow("Verify");
      expect(provider.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a late verification after disposal and leaves no connected record", async () => {
    const provider = deferredProvider();
    const result = configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    const assertion = expect(result).rejects.toThrow();
    await provider.ready;
    provider.dispose();
    provider.answer();
    await assertion;
    expect(readDeviceRows()).toEqual([]);
  });
  it("does not publish an old read after concurrent credential replacement", async () => {
    const first = nativeAnswers({ body: { name: "Original" } });
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      first.transport,
    );
    const old = deferredProvider();
    const result = invokeNativeApiConnector(
      view.connectionId,
      "provider.read",
      {},
      old.transport,
    );
    const assertion = expect(result).rejects.toThrow("changed");
    await old.ready;
    const replacement = nativeAnswers({ body: { name: "Replacement" } });
    await configureNativeApiConnector(
      {
        ...nativeApiDraft(),
        connectionId: view.connectionId,
        revision: view.revision,
        credentials: { api_key: "private-replacement" },
      },
      replacement.transport,
    );
    old.answer();
    await assertion;
    expect(
      loadNativeConnectorRecord(view.connectionId)?.privateState.credentials
        .api_key,
    ).toBe("private-replacement");
    expect(readNativeConnector(view.connectionId)?.identity?.label).toBe(
      "Replacement",
    );
  });
  it("marks an existing ready record pending when re-verification actually receives 401", async () => {
    const provider = nativeAnswers(
      { body: { name: "Team" } },
      { body: {}, status: 401 },
    );
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    await expect(
      verifyNativeApiConnector(view.connectionId, provider.transport),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(readNativeConnector(view.connectionId)?.status).toBe("reauthorize");
  });
  it("does not retain a blank key after changing the compiled Algolia application", async () => {
    const provider = nativeAnswers({ body: { items: [] } });
    const view = await configureNativeApiConnector(
      {
        ...nativeApiDraft("algolia"),
        parameters: { application_id: "first-app" },
      },
      provider.transport,
    );
    await expect(
      configureNativeApiConnector(
        {
          ...nativeApiDraft("algolia"),
          connectionId: view.connectionId,
          revision: view.revision,
          parameters: { application_id: "second-app" },
          credentials: { api_key: "" },
        },
        provider.transport,
      ),
    ).rejects.toThrow("required provider credentials");
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts the actual HTTP request and rejects late ignored-abort responses", async () => {
    const provider = deferredProvider();
    const controller = new AbortController();
    const result = nativeApiHttp(
      {
        url: "https://api.notion.com/v1/users/me",
        method: "GET",
        headers: new Headers(),
        signal: controller.signal,
      },
      provider.transport,
    );
    const assertion = expect(result).rejects.toMatchObject({ code: "network" });
    await provider.ready;
    const signal = provider.transport.fetch.mock.calls[0]?.[1]?.signal;
    controller.abort();
    expect(signal?.aborted).toBe(true);
    provider.answer();
    await assertion;
  });
  it("rejects reflected credentials in a model prompt before any model request", async () => {
    const provider = nativeAnswers({ body: { data: [] } });
    const view = await configureNativeApiConnector(
      nativeApiDraft("openai"),
      provider.transport,
    );
    await expect(
      executeNativeApiRequest(
        view.connectionId,
        {
          providerId: "openai",
          operationId: "model.generate",
          method: "POST",
          path: "/v1/chat/completions",
        },
        { prompt: "Please copy private-native-key" },
        () => "answer",
        provider.transport,
      ),
    ).rejects.toThrow();
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });
  it("forgets an externally-created API key through durable cleanup without claiming provider revocation", async () => {
    const provider = nativeAnswers({ body: { name: "Team" } });
    const view = await configureNativeApiConnector(
      nativeApiDraft(),
      provider.transport,
    );
    const unregister = registerNativeProviderCleanup(
      "notion",
      nativeApiCleanup,
    );
    try {
      expect(await removeNativeConnectorWithCleanup(view.connectionId)).toBe(
        true,
      );
      expect(readNativeConnector(view.connectionId)).toBeNull();
      expect(provider.fetch).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
