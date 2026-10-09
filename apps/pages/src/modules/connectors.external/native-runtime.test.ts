import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import {
  modelMemoryBackend,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeRuntime } from "./native-runtime.js";

afterEach(() => vi.restoreAllMocks());
describe("native provider capability lifetime", () => {
  it.each(["lease", "dispose"])(
    "refuses captured transports and late HTTP results after %s",
    async (disable) => {
      const test = createTestContext();
      let resolveLate = (_response: Response) => {};
      const late = new Promise<Response>((resolve) => {
        resolveLate = resolve;
      });
      let requestSignal: AbortSignal | undefined;
      const fetcher = vi.fn<typeof test.ctx.egress.fetch>((_url, init) => {
        requestSignal = init?.signal ?? undefined;
        return late;
      });
      const ctx = {
        ...test.ctx,
        egress: { ...test.ctx.egress, fetch: fetcher },
      };
      const activation = createActivation(ctx, "connectors.external");
      bindNativeRuntime(ctx, activation);
      const transport = nativeProviderTransport();
      const request = transport.fetch("https://api.github.com/user", {});
      expect(fetcher).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        { capability: "connectors.external", purpose: NATIVE_PROVIDER_PURPOSE },
      );
      if (disable === "lease") test.abort("disabled");
      else activation.dispose();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(requestSignal?.aborted).toBe(true);
      expect(() => transport.assertCurrent()).toThrow();
      expect(() => nativeProviderTransport()).toThrow();
      resolveLate(new Response("late success"));
      await expect(
        transport.fetch("https://api.github.com/user", {}),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
      activation.dispose();
    },
  );

  it.each(["fetch", "settleCredentialMutation"] as const)(
    "preserves POST Request headers and payload in %s",
    async (kind) => {
      const test = createTestContext();
      const fetcher = vi.fn<typeof test.ctx.egress.fetch>(async (url, init) => {
        const received = new Request(url, init);
        expect(received.method).toBe("POST");
        expect(received.headers.get("authorization")).toBe(
          "Bearer fixture-credential",
        );
        expect(received.headers.get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(await received.text()).toBe(
          "grant_type=authorization_code&code=fixture-code",
        );
        return Response.json({ accepted: true });
      });
      const ctx = {
        ...test.ctx,
        egress: { ...test.ctx.egress, fetch: fetcher },
      };
      const activation = createActivation(ctx, "connectors.external");
      bindNativeRuntime(ctx, activation);
      const transport = nativeProviderTransport();
      const send = transport[kind];
      if (!send) throw new Error("Missing transport fixture");
      try {
        const response = await send(
          new Request("https://gitlab.com/oauth/token", {
            method: "POST",
            headers: {
              authorization: "Bearer fixture-credential",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: "grant_type=authorization_code&code=fixture-code",
          }),
        );
        expect(response.ok).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0]?.[2]).toEqual({
          capability: "connectors.external",
          purpose: NATIVE_PROVIDER_PURPOSE,
        });
      } finally {
        activation.dispose();
      }
    },
  );
  it.each(["fetch", "settleCredentialMutation"] as const)(
    "honors explicit Request init overrides in %s",
    async (kind) => {
      const test = createTestContext();
      const fetcher = vi.fn<typeof test.ctx.egress.fetch>(async (url, init) => {
        const received = new Request(url, init);
        expect(received.method).toBe("POST");
        expect(received.headers.get("authorization")).toBe(
          "Bearer replacement-credential",
        );
        expect(received.headers.has("x-original")).toBe(false);
        expect(await received.text()).toBe("replacement body");
        return Response.json({ accepted: true });
      });
      const ctx = {
        ...test.ctx,
        egress: { ...test.ctx.egress, fetch: fetcher },
      };
      const activation = createActivation(ctx, "connectors.external");
      bindNativeRuntime(ctx, activation);
      const send = nativeProviderTransport()[kind];
      if (!send) throw new Error("Missing transport fixture");
      try {
        await send(
          new Request("https://gitlab.com/oauth/token", {
            method: "GET",
            headers: { "x-original": "discarded" },
          }),
          {
            method: "POST",
            headers: { authorization: "Bearer replacement-credential" },
            body: "replacement body",
          },
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        activation.dispose();
      }
    },
  );
  it("honors an aborted Request signal before provider fetch", async () => {
    const test = createTestContext();
    const fetcher = vi.fn<typeof test.ctx.egress.fetch>();
    const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
    const activation = createActivation(ctx, "connectors.external");
    bindNativeRuntime(ctx, activation);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        nativeProviderTransport().fetch(
          new Request("https://gitlab.com/oauth/token", {
            method: "POST",
            body: "never sent",
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      activation.dispose();
    }
  });

  it("does not replace a newer authorization projector when an older activation disposes", () => {
    const initial = nativeDeviceViewSeams.authorization;
    const olderContext = createTestContext();
    const newerContext = createTestContext();
    const older = createActivation(olderContext.ctx, "connectors.external");
    const newer = createActivation(newerContext.ctx, "connectors.external");
    bindNativeRuntime(olderContext.ctx, older);
    bindNativeRuntime(newerContext.ctx, newer);
    const newest = nativeDeviceViewSeams.authorization;
    older.dispose();
    expect(nativeDeviceViewSeams.authorization).toBe(newest);
    newer.dispose();
    expect(nativeDeviceViewSeams.authorization("missing")).toBeNull();
    nativeDeviceViewSeams.authorization = initial;
  });
  it("projects the earliest grant expiry and refresh availability without revealing tokens", async () => {
    modelMemoryBackend();
    const id = await saveModelFixture("openai");
    const saved = readNativeConnector(id);
    if (!saved) throw new Error("Missing native fixture");
    const expiresAt = Date.now() + 60_000;
    await updateNativeConnector(
      id,
      { revision: saved.revision, fingerprint: saved.fingerprint },
      { publicParameters: [], privateCredentials: ["api_key"] },
      (record) => {
        record.configuration.method = "oauth";
        const grant = record.privateState.grants.app;
        const publicGrant = record.runtime.grants[0];
        if (!grant || !publicGrant)
          throw new Error("Missing native grant fixture");
        grant.kind = "oauth";
        grant.expiresAt = expiresAt;
        grant.refreshToken = "private-refresh-fixture";
        publicGrant.expiresAt = expiresAt;
        const userGrant = {
          ...grant,
          actor: "user",
          expiresAt: expiresAt + 60_000,
        };
        record.privateState.grants.user = userGrant;
        record.runtime.grants.push({
          ...publicGrant,
          actor: "user",
          expiresAt: userGrant.expiresAt,
        });
        const verifiedAt = Date.now();
        record.privateState.verification = {
          fingerprint: saved.fingerprint,
          verifiedAt,
          kind: "provider",
        };
        record.runtime.verifiedAt = verifiedAt;
        return record;
      },
    );
    const test = createTestContext();
    const activation = createActivation(test.ctx, "connectors.external");
    bindNativeRuntime(test.ctx, activation);
    try {
      const projection = nativeDeviceViewSeams.authorization(id);
      expect(projection).toMatchObject({
        status: "active",
        statusDetail: null,
        expiresAt: new Date(expiresAt).toISOString(),
        refreshable: true,
      });
      expect(JSON.stringify(projection)).not.toContain(
        "private-refresh-fixture",
      );
    } finally {
      activation.dispose();
    }
  });
  it.each(["configuration", "authorizing", "reauthorize", "cleanup"] as const)(
    "keeps %s pending with an accurate status detail",
    async (status) => {
      modelMemoryBackend();
      const id = await saveModelFixture("openai", status !== "configuration");
      const saved = readNativeConnector(id);
      if (!saved) throw new Error("Missing native fixture");
      if (status !== "configuration")
        await updateNativeConnector(
          id,
          { revision: saved.revision, fingerprint: saved.fingerprint },
          { publicParameters: [], privateCredentials: ["api_key"] },
          (record) => {
            if (status === "authorizing")
              record.privateState.pending.app = {
                providerId: "openai",
                actor: "app",
                fingerprint: saved.fingerprint,
                state: "s".repeat(32),
                verifier: "v".repeat(43),
                redirectUri: "https://self-hosted.example/callback",
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                scopes: [],
              };
            if (status === "reauthorize") {
              const grant = record.runtime.grants[0];
              if (grant) grant.needsReauth = true;
            }
            if (status === "cleanup")
              record.privateState.recovery.push({
                providerId: "openai",
                actor: "app",
                fingerprint: saved.fingerprint,
                id: "cleanup-entry",
                kind: "revoke",
                targetId: "app",
              });
            return record;
          },
        );
      const test = createTestContext();
      const activation = createActivation(test.ctx, "connectors.external");
      bindNativeRuntime(test.ctx, activation);
      try {
        const projection = nativeDeviceViewSeams.authorization(id);
        expect(projection?.status).toBe("pending");
        const expected = {
          configuration: "Configured on this device",
          authorizing: "in progress",
          reauthorize: "authorize again",
          cleanup: "cleanup required",
        };
        expect(projection?.statusDetail).toContain(expected[status]);
        expect(projection?.grantedScopes).toEqual([]);
      } finally {
        activation.dispose();
      }
    },
  );

  it("does not install usable provider ports under an already aborted lease", () => {
    const test = createTestContext();
    test.abort("already disabled");
    const activation = createActivation(test.ctx, "connectors.external");
    bindNativeRuntime(test.ctx, activation);
    expect(() => nativeProviderTransport()).toThrow();
    expect(test.egressCalls).toEqual([]);
    activation.dispose();
  });

  it("retains a completed late credential mutation for cleanup while refusing new requests", async () => {
    const test = createTestContext();
    let resolveLate = (_response: Response) => {};
    const fetcher = vi.fn<typeof test.ctx.egress.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
    const activation = createActivation(ctx, "connectors.external");
    bindNativeRuntime(ctx, activation);
    const captured = nativeProviderTransport();
    const mutation = captured.settleCredentialMutation?.(
      "https://gitlab.com/oauth/token",
      { method: "POST" },
    );
    activation.dispose();
    resolveLate(new Response("complete credential response"));
    expect(await (await mutation)?.text()).toBe("complete credential response");
    await expect(
      captured.settleCredentialMutation?.("https://gitlab.com/oauth/token", {
        method: "POST",
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it.each([
  "credential-valid",
  "account-verified",
  "workspace-verified",
] as const)(
  "projects account labels only for an account-verified identity (%s)",
  async (assurance) => {
    modelMemoryBackend();
    const id = await saveModelFixture("algolia");
    const saved = readNativeConnector(id);
    if (!saved) throw new Error("Missing native fixture");
    await updateNativeConnector(
      id,
      saved,
      { publicParameters: [], privateCredentials: ["api_key"] },
      (record) => {
        record.runtime.identity = {
          id: "verified-id",
          label: "Provider access verified",
          kind: "entity",
          assurance,
        };
        return record;
      },
    );
    const test = createTestContext();
    const activation = createActivation(test.ctx, "connectors.external");
    bindNativeRuntime(test.ctx, activation);
    try {
      expect(nativeDeviceViewSeams.authorization(id)?.accountLabel).toBe(
        assurance === "account-verified" ? "Provider access verified" : null,
      );
    } finally {
      activation.dispose();
    }
  },
);
