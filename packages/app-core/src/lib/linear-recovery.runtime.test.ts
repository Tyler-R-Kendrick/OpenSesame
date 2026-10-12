import { describe, expect, it, vi } from "vitest";
import { readDeviceSecrets } from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import {
  beginLinearAuthorization,
  configureLinearConnector,
  linearReconnectPlan,
  readLinearConnector,
} from "./linear-connectors.js";
import {
  finishRecoveryConsent,
  installRecoveryProvider,
  oauthWebhookFixture,
  recoveryOptions,
} from "./linear-recovery.test-support.js";
import {
  installLinearRuntimeTests,
  linearDraft,
  pendingLinear,
} from "./linear-runtime.test-support.js";
import {
  linearGrant,
  linearPublicRecord,
  updateLinearRecord,
} from "./linear-store.js";
import { configureLinearWebhooks } from "./linear-webhooks.js";

installLinearRuntimeTests();
describe("workspace-bound Linear webhook recovery", () => {
  it.each([false, true])(
    "reconsents expired OAuth without losing the registered or pending hook (pending=%s)",
    async (pendingHook) => {
      const { id, provider } = await oauthWebhookFixture(pendingHook);
      installRecoveryProvider();
      const oldId = provider.created[0];
      await beginLinearAuthorization(id, "app");
      expect(readLinearConnector(id)?.recovery).toEqual({
        workspaceId: "workspace-1",
        phase: "cleanup",
      });
      expect(linearGrant(id, "app")).toBeNull();
      expect(provider.hooks.has(oldId ?? "")).toBe(true);
      expect(deviceConnection(id)?.status).toBe("pending");
      expect(pendingLinear(id).scopes).toContain("admin");
      const connected = await finishRecoveryConsent(id);
      expect(connected?.status).toBe("active");
      expect(readLinearConnector(id)?.recovery).toBeUndefined();
      expect(provider.deleted).toEqual([oldId]);
      expect(provider.created).toHaveLength(2);
      expect(provider.hooks.size).toBe(1);
      expect(readLinearConnector(id)?.webhook?.id).toBe(provider.created[1]);
    },
  );

  it.each([false, true])(
    "rejects wrong-workspace recovery consent even with no filter or old app identity (pending=%s)",
    async (pendingHook) => {
      const { id, provider } = await oauthWebhookFixture(pendingHook);
      const fixture = installRecoveryProvider();
      await beginLinearAuthorization(id, "app");
      expect(readLinearConnector(id)?.app).toBeNull();
      fixture.wrongWorkspace = true;
      await expect(finishRecoveryConsent(id)).rejects.toThrow(
        "original Linear workspace",
      );
      expect(linearGrant(id, "app")).toBeNull();
      expect(readLinearConnector(id)?.recovery?.workspaceId).toBe(
        "workspace-1",
      );
      expect(provider.deleted).toHaveLength(0);
      expect(provider.hooks.size).toBe(1);
      expect(fixture.revoked).toContain("fresh-cleanup");
      expect(deviceConnection(id)?.status).toBe("pending");
    },
  );

  it("retains the obligation and replacement grant after cleanup failure, then retries with the same workspace", async () => {
    const { id, provider } = await oauthWebhookFixture();
    const fixture = installRecoveryProvider();
    await beginLinearAuthorization(id, "app");
    fixture.failDelete = true;
    await expect(finishRecoveryConsent(id)).rejects.toMatchObject({
      status: 503,
    });
    expect(readLinearConnector(id)?.recovery?.phase).toBe("cleanup");
    expect(linearGrant(id, "app")?.accessToken).toBe("fresh-cleanup");
    expect(provider.hooks.size).toBe(1);
    expect(deviceConnection(id)?.status).toBe("pending");
    fixture.failDelete = false;
    await configureLinearWebhooks(id);
    expect(provider.deleted).toHaveLength(1);
    expect(provider.created).toHaveLength(2);
    expect(deviceConnection(id)?.status).toBe("active");
    expect(readLinearConnector(id)?.recovery).toBeUndefined();
  });

  it("resumes a failed replacement creation without re-deleting or duplicating the subscription", async () => {
    const { id, provider } = await oauthWebhookFixture();
    const fixture = installRecoveryProvider();
    await beginLinearAuthorization(id, "app");
    fixture.failCreate = true;
    await expect(finishRecoveryConsent(id)).rejects.toMatchObject({
      status: 503,
    });
    expect(readLinearConnector(id)?.recovery?.phase).toBe("configure");
    const intent = readDeviceSecrets()[id]?.linear_webhook_intent;
    expect(intent).toBeTruthy();
    expect(provider.deleted).toHaveLength(1);
    fixture.failCreate = false;
    await configureLinearWebhooks(id);
    expect(provider.deleted).toHaveLength(1);
    expect(provider.created).toHaveLength(2);
    expect(intent).toContain(provider.created[1]);
    expect(deviceConnection(id)?.status).toBe("active");
  });

  it("retries a failed final recovery-marker write without deleting the newly configured webhook", async () => {
    const { id, provider } = await oauthWebhookFixture();
    installRecoveryProvider();
    await beginLinearAuthorization(id, "app");
    provider.onCreate = () => {
      const durable = vi.mocked(kvSeams.kvSetDurable).getMockImplementation();
      if (!durable) throw new Error("Durable test port required");
      vi.mocked(kvSeams.kvSetDurable)
        .mockImplementationOnce(durable)
        .mockRejectedValueOnce(
          new Error("Recovery completion could not be stored"),
        );
    };
    await expect(finishRecoveryConsent(id)).rejects.toThrow(
      "Recovery completion could not be stored",
    );
    const newId = readLinearConnector(id)?.webhook?.id;
    expect(newId).toBe(provider.created[1]);
    expect(readLinearConnector(id)?.recovery?.phase).toBe("configure");
    expect(deviceConnection(id)?.status).toBe("pending");
    await configureLinearWebhooks(id);
    expect(provider.deleted).toEqual([provider.created[0]]);
    expect(provider.hooks.has(newId ?? "")).toBe(true);
    expect(provider.created).toHaveLength(2);
    expect(deviceConnection(id)?.status).toBe("active");
  });

  it("uses temporary admin consent to remove a pending hook, then revokes it and obtains the selected read-only grant", async () => {
    const { id, provider } = await oauthWebhookFixture(true);
    const fixture = installRecoveryProvider();
    expect(linearReconnectPlan(id)).toEqual({
      cleanupNeeded: true,
      temporaryAdmin: false,
    });
    await configureLinearConnector(
      linearDraft("oauth"),
      {
        ...recoveryOptions,
        appScopes: ["read"],
        webhookEnabled: false,
      },
      id,
    );
    expect(linearReconnectPlan(id)).toEqual({
      cleanupNeeded: true,
      temporaryAdmin: true,
    });
    expect(pendingLinear(id).scopes).toEqual(["read", "admin"]);
    const intermediate = await finishRecoveryConsent(id);
    expect(intermediate).toBeNull();
    expect(provider.hooks.size).toBe(0);
    expect(readLinearConnector(id)?.recovery?.phase).toBe("configure");
    expect(linearGrant(id, "app")).toBeNull();
    expect(deviceConnection(id)?.status).toBe("pending");
    expect(fixture.revoked).toContain("fresh-cleanup");
    expect(fixture.revoked).toContain("fresh-refresh-cleanup");
    expect(pendingLinear(id).scopes).toEqual(["read"]);
    const connected = await finishRecoveryConsent(id, "desired");
    expect(connected?.status).toBe("active");
    expect(linearGrant(id, "app")?.scopes).toEqual(["read"]);
    expect(readLinearConnector(id)?.app?.grantedScopes).toEqual(["read"]);
    expect(readLinearConnector(id)?.recovery).toBeUndefined();
    expect(provider.created).toHaveLength(1);
  });

  it("refuses unsolicited admin on final narrowing consent and allows a clean retry", async () => {
    const { id } = await oauthWebhookFixture(true);
    const fixture = installRecoveryProvider();
    await configureLinearConnector(
      linearDraft("oauth"),
      { ...recoveryOptions, appScopes: ["read"], webhookEnabled: false },
      id,
    );
    await finishRecoveryConsent(id);
    await expect(finishRecoveryConsent(id, "excess-admin")).rejects.toThrow(
      "retained temporary admin",
    );
    expect(fixture.revoked).toContain("fresh-excess-admin");
    expect(linearGrant(id, "app")).toBeNull();
    expect(readLinearConnector(id)?.recovery?.phase).toBe("configure");
    expect(deviceConnection(id)?.status).toBe("pending");
    await beginLinearAuthorization(id, "app");
    expect(pendingLinear(id).scopes).toEqual(["read"]);
    await finishRecoveryConsent(id, "desired");
    expect(linearGrant(id, "app")?.scopes).toEqual(["read"]);
    expect(deviceConnection(id)?.status).toBe("active");
  });

  it("resets a retained configure marker before disabling a newly registered webhook and narrowing scopes", async () => {
    const { id, provider } = await oauthWebhookFixture();
    installRecoveryProvider();
    await beginLinearAuthorization(id, "app");
    provider.onCreate = () => {
      const durable = vi.mocked(kvSeams.kvSetDurable).getMockImplementation();
      if (!durable) throw new Error("Durable port required");
      vi.mocked(kvSeams.kvSetDurable)
        .mockImplementationOnce(durable)
        .mockRejectedValueOnce(new Error("Final marker failed"));
    };
    await expect(finishRecoveryConsent(id)).rejects.toThrow(
      "Final marker failed",
    );
    provider.onCreate = () => {};
    const retainedId = readLinearConnector(id)?.webhook?.id;
    await configureLinearConnector(
      linearDraft("oauth"),
      { ...recoveryOptions, appScopes: ["read"], webhookEnabled: false },
      id,
    );
    expect(readLinearConnector(id)?.recovery?.phase).toBe("cleanup");
    expect(provider.hooks.has(retainedId ?? "")).toBe(true);
    expect(pendingLinear(id).scopes).toEqual(["read", "admin"]);
    await finishRecoveryConsent(id, "second-cleanup");
    expect(provider.hooks.size).toBe(0);
    expect(pendingLinear(id).scopes).toEqual(["read"]);
    await finishRecoveryConsent(id, "desired");
    expect(provider.deleted).toEqual(provider.created);
    expect(linearGrant(id, "app")?.scopes).toEqual(["read"]);
    expect(readLinearConnector(id)?.recovery).toBeUndefined();
    expect(deviceConnection(id)?.status).toBe("active");
  });

  it("does not interpret an offline cleanup request with a healthy grant as a reason to discard authorization", async () => {
    const { id, provider } = await oauthWebhookFixture();
    await updateLinearRecord(id, async (record, runtime) => {
      if (!runtime.app) throw new Error("App grant required");
      return linearPublicRecord(record, {
        ...runtime,
        app: {
          ...runtime.app,
          needsReauth: false,
          expiresAt: Date.now() + 86_400_000,
        },
      });
    });
    const fixture = installRecoveryProvider();
    fixture.failNetwork = true;
    await expect(
      configureLinearConnector(
        linearDraft("oauth"),
        { ...recoveryOptions, webhookUrl: "https://new.example.org/linear" },
        id,
      ),
    ).rejects.toMatchObject({ code: "network" });
    expect(readLinearConnector(id)?.recovery).toBeUndefined();
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    expect(provider.deleted).toHaveLength(0);
    expect(provider.hooks.size).toBe(1);
  });

  it("reauthorizes a marked-invalid user with existing scopes before completing pending app recovery", async () => {
    const { id, provider } = await oauthWebhookFixture(true);
    installRecoveryProvider();
    await configureLinearConnector(
      linearDraft("oauth"),
      { ...recoveryOptions, userScopes: ["read"] },
      id,
    );
    await updateLinearRecord(id, async (record, runtime) => {
      const expiresAt = Date.now() + 86_400_000;
      return linearPublicRecord(
        {
          ...record,
          secrets: {
            ...record.secrets,
            linear_user_grant: JSON.stringify({
              kind: "oauth",
              accessToken: "fresh-user-access",
              refreshToken: "fresh-user-refresh",
              scopes: ["read"],
              expiresAt,
            }),
          },
        },
        {
          ...runtime,
          user: {
            accountLabel: "User requires reconnection",
            workspaceId: "workspace-1",
            workspaceName: "Acme",
            workspaceKey: "acme",
            kind: "oauth",
            grantedScopes: ["read"],
            expiresAt,
            needsReauth: true,
          },
        },
      );
    });
    expect(pendingLinear(id).actor).toBe("app");
    const intermediate = await finishRecoveryConsent(id);
    expect(intermediate).toBeNull();
    expect(pendingLinear(id).actor).toBe("user");
    expect(pendingLinear(id).scopes).toEqual(["read"]);
    expect(readLinearConnector(id)?.user).toBeNull();
    expect(readLinearConnector(id)?.recovery?.phase).toBe("cleanup");
    expect(provider.hooks.size).toBe(1);
    const connected = await finishRecoveryConsent(id, "desired");
    expect(connected?.status).toBe("active");
    expect(readLinearConnector(id)?.user?.needsReauth).toBeUndefined();
    expect(readLinearConnector(id)?.user?.grantedScopes).toEqual(["read"]);
    expect(readLinearConnector(id)?.recovery).toBeUndefined();
    expect(provider.deleted).toHaveLength(1);
    expect(provider.created).toHaveLength(2);
  });
  it("revokes temporary cleanup authorization without retaining an app grant when no app scopes are selected", async () => {
    const { id, provider } = await oauthWebhookFixture(true);
    const fixture = installRecoveryProvider();
    await configureLinearConnector(
      linearDraft("oauth"),
      {
        ...recoveryOptions,
        appScopes: [],
        userScopes: ["read"],
        webhookEnabled: false,
      },
      id,
    );
    await updateLinearRecord(id, async (record, runtime) => {
      const expiresAt = Date.now() + 86_400_000;
      return linearPublicRecord(
        {
          ...record,
          secrets: {
            ...record.secrets,
            linear_user_grant: JSON.stringify({
              kind: "oauth",
              accessToken: "fresh-user",
              refreshToken: "fresh-user-refresh",
              scopes: ["read"],
              expiresAt,
            }),
          },
        },
        {
          ...runtime,
          user: {
            accountLabel: "Configured user",
            workspaceId: "workspace-1",
            workspaceName: "Acme",
            workspaceKey: "acme",
            kind: "oauth",
            grantedScopes: ["read"],
            expiresAt,
          },
        },
      );
    });
    expect(pendingLinear(id).scopes).toEqual(["read", "admin"]);
    const connected = await finishRecoveryConsent(id);
    expect(connected?.status).toBe("active");
    expect(readLinearConnector(id)?.app).toBeNull();
    expect(linearGrant(id, "app")).toBeNull();
    expect(readLinearConnector(id)?.recovery).toBeUndefined();
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    expect(fixture.issued).toEqual(["cleanup"]);
    expect(fixture.revoked).toContain("fresh-cleanup");
    expect(provider.hooks.size).toBe(0);
  });
});
