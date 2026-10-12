import { describe, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import { linearApiSeams } from "./linear-api.js";
import {
  configureLinearConnector,
  finishLinearAuthorization,
  readLinearConnector,
} from "./linear-connectors.js";
import { invokeLinearConnector } from "./linear-operations.js";
import { revokeLinearConnector } from "./linear-revoke.js";
import {
  installLinearProvider,
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  pendingLinear,
} from "./linear-runtime.test-support.js";
import {
  linearGrant,
  linearPublicRecord,
  updateLinearRecord,
} from "./linear-store.js";

installLinearRuntimeTests();
async function authorized() {
  const saved = await configureLinearConnector(
    linearDraft("oauth"),
    linearOptions,
  );
  const pending = pendingLinear(saved.connectionId);
  linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
  await finishLinearAuthorization(
    `?linear_state=${pending.state}&linear_code=code`,
  );
  return saved.connectionId;
}
function pauseWebhookRead(operation = "OpenSesameWebhooks") {
  const fetch = linearApiSeams.fetch;
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  linearApiSeams.fetch = vi.fn(async (url, init) => {
    if (!paused && String(init?.body).includes(operation)) {
      paused = true;
      entered();
      await resumed;
    }
    return fetch(url, init);
  });
  return { waiting, release };
}

describe("Linear disconnect retries and concurrent edits", () => {
  it("retains both old and newly rotated credentials when cleanup recovery fails, then clears both on retry", async () => {
    const id = await authorized();
    linearAnswers(
      { body: {}, status: 400 },
      {
        body: {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 86400,
          token_type: "Bearer",
          scope: "read",
        },
      },
      { body: null },
      { body: {}, status: 503 },
    );
    await expect(revokeLinearConnector(id)).rejects.toMatchObject({
      status: 503,
    });
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toContain(
      "fresh-access",
    );
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toContain(
      "fresh-refresh",
    );
    expect(JSON.stringify(readDeviceRows())).not.toContain("fresh-access");
    expect(deviceConnection(id)?.status).toBe("pending");
    linearAnswers(
      { body: null },
      { body: null },
      { body: {}, status: 400 },
      { body: { error: "invalid_grant" }, status: 400 },
      { body: {}, status: 400 },
      { body: {}, status: 401 },
    );
    await revokeLinearConnector(id);
    expect(readDeviceSecrets()[id]).toBeUndefined();
    expect(deviceConnection(id)).toBeNull();
  });

  it("marks a refused provider token pending and stops further operations until reconnection", async () => {
    const id = await authorized();
    const fetcher = linearAnswers({ body: {}, status: 401 });
    await expect(
      invokeLinearConnector(id, "issues.list"),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(deviceConnection(id)?.status).toBe("pending");
    await expect(invokeLinearConnector(id, "issues.list")).rejects.toThrow(
      "Finish Linear authorization",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(linearGrant(id, "app")).not.toBeNull();
  });
  it("revokes both refresh and access credentials before deleting the sealed configuration", async () => {
    const id = await authorized();
    const fetcher = linearAnswers({ body: null }, { body: null });
    await revokeLinearConnector(id);
    const forms = fetcher.mock.calls.map(([, init]) =>
      Object.fromEntries(new URLSearchParams(String(init?.body))),
    );
    expect(forms).toEqual([
      { token: "private-refresh", token_type_hint: "refresh_token" },
      { token: "private-access", token_type_hint: "access_token" },
    ]);
    expect(deviceConnection(id)).toBeNull();
    expect(readDeviceSecrets()).toEqual({});
  });

  it("keeps the provider grant when a revocation fails and allows a later retry", async () => {
    const id = await authorized();
    linearAnswers({ body: { error: "unavailable" }, status: 503 });
    await expect(revokeLinearConnector(id)).rejects.toMatchObject({
      status: 503,
    });
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    linearAnswers({ body: null }, { body: null });
    await revokeLinearConnector(id);
    expect(deviceConnection(id)).toBeNull();
  });

  it("remembers a successfully revoked actor before attempting a second actor", async () => {
    const id = await authorized();
    await updateLinearRecord(id, async (record, runtime) =>
      linearPublicRecord(
        {
          ...record,
          secrets: {
            ...record.secrets,
            linear_user_grant: JSON.stringify({
              kind: "oauth",
              accessToken: "user-access",
              refreshToken: "user-refresh",
              expiresAt: Date.now() + 60_000,
              scopes: ["read"],
            }),
          },
        },
        { ...runtime, user: runtime.app },
      ),
    );
    linearAnswers(
      { body: null },
      { body: null },
      { body: { error: "unavailable" }, status: 503 },
    );
    await expect(revokeLinearConnector(id)).rejects.toMatchObject({
      status: 503,
    });
    expect(linearGrant(id, "app")).toBeNull();
    expect(linearGrant(id, "user")).not.toBeNull();
    const retry = linearAnswers({ body: null }, { body: null });
    await revokeLinearConnector(id);
    expect(retry).toHaveBeenCalledTimes(2);
    const form = new URLSearchParams(String(retry.mock.calls[0]?.[1]?.body));
    expect(form.get("token")).toBe("user-refresh");
    expect(deviceConnection(id)).toBeNull();
  });

  it("reconciles already revoked tokens after a failed durable cleanup save", async () => {
    const id = await authorized();
    linearAnswers({ body: null }, { body: null });
    vi.mocked(kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Revocation save failed"),
    );
    await expect(revokeLinearConnector(id)).rejects.toThrow(
      "Revocation save failed",
    );
    expect(linearGrant(id, "app")).not.toBeNull();
    const retry = linearAnswers(
      { body: { error: "revoked" }, status: 400 },
      { body: { error: "invalid_grant" }, status: 400 },
      { body: { error: "revoked" }, status: 400 },
      { body: { error: "invalid" }, status: 401 },
    );
    await revokeLinearConnector(id);
    expect(retry.mock.calls[1]?.[0]).toBe("https://api.linear.app/oauth/token");
    expect(retry.mock.calls[3]?.[0]).toBe("https://api.linear.app/graphql");
    expect(deviceConnection(id)).toBeNull();
  });

  it("never interprets invalid_client or an offline token probe as successful revocation", async () => {
    const id = await authorized();
    linearAnswers(
      { body: { error: "revoked" }, status: 400 },
      { body: { error: "invalid_client" }, status: 401 },
    );
    await expect(revokeLinearConnector(id)).rejects.toMatchObject({
      oauthError: "invalid_client",
    });
    expect(linearGrant(id, "app")).not.toBeNull();
  });

  it("detects an edit committed during API-key verification even if timestamps match", async () => {
    linearAnswers({ body: { data: linearAccount } });
    const saved = await configureLinearConnector(linearDraft(), linearOptions);
    let answer = (_response: Response) => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reply = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    linearApiSeams.fetch = vi.fn(async () => {
      entered();
      return reply;
    });
    const edit = configureLinearConnector(
      { ...linearDraft(), name: "Stale edit" },
      linearOptions,
      saved.connectionId,
    );
    await waiting;
    await updateLinearRecord(saved.connectionId, async (record) => ({
      ...record,
      row: { ...record.row, displayName: "Concurrent edit" },
    }));
    answer(new Response(JSON.stringify({ data: linearAccount })));
    await expect(edit).rejects.toThrow("changed in another tab");
    expect(readDeviceRows()[0]?.displayName).toBe("Concurrent edit");
  });

  it.each(["OpenSesameWebhooks", "OpenSesameDeleteWebhook"])(
    "serializes configuration saves while %s is in flight and never retains a deleted webhook as active",
    async (operation) => {
      const provider = installLinearProvider();
      const options = {
        ...linearOptions,
        webhookEnabled: true,
        webhookUrl: "https://hooks.example.org/linear",
        webhookResourceTypes: ["Issue"],
      };
      const saved = await configureLinearConnector(linearDraft(), options);
      const pause = pauseWebhookRead(operation);
      const edit = configureLinearConnector(
        { ...linearDraft(), name: "Webhook disabled" },
        { ...options, webhookEnabled: false },
        saved.connectionId,
      );
      await pause.waiting;
      const concurrent = configureLinearConnector(
        { ...linearDraft(), name: "Concurrent stale edit", key: "" },
        options,
        saved.connectionId,
      );
      const rejected = expect(concurrent).rejects.toThrow(
        "changed in another tab",
      );
      pause.release();
      await Promise.all([edit, rejected]);
      expect(readDeviceRows()[0]?.displayName).toBe("Webhook disabled");
      expect(readDeviceRows()[0]?.fields.self_hosted_configuration).toContain(
        '"webhookEnabled":false',
      );
      expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
        "private-api-key",
      );
      expect(
        readDeviceSecrets()[saved.connectionId]?.linear_webhook_secret,
      ).toBeUndefined();
      expect(provider.deleted).toEqual(provider.created);
      expect(provider.hooks.size).toBe(0);
      expect(readLinearConnector(saved.connectionId)?.webhook).toBeNull();
      expect(deviceConnection(saved.connectionId)?.status).toBe("active");
    },
  );

  it("preserves a surviving OAuth grant renewed during webhook cleanup with unchanged configuration", async () => {
    const options = { ...linearOptions, appScopes: ["read", "admin"] };
    const saved = await configureLinearConnector(linearDraft("oauth"), options);
    const pending = pendingLinear(saved.connectionId);
    linearAnswers(
      { body: { ...linearToken, scope: "read admin" } },
      { body: { data: linearAccount } },
    );
    await finishLinearAuthorization(
      `?linear_state=${pending.state}&linear_code=code`,
    );
    installLinearProvider();
    const withWebhook = {
      ...options,
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.org/linear",
      webhookResourceTypes: ["Issue"],
    };
    await configureLinearConnector(
      linearDraft("oauth"),
      withWebhook,
      saved.connectionId,
    );
    const pause = pauseWebhookRead();
    const edit = configureLinearConnector(
      linearDraft("oauth"),
      { ...withWebhook, webhookEnabled: false },
      saved.connectionId,
    );
    await pause.waiting;
    const renewal = updateLinearRecord(
      saved.connectionId,
      async (record, runtime) => {
        if (!runtime.app) throw new Error("App grant required");
        return linearPublicRecord(
          {
            ...record,
            secrets: {
              ...record.secrets,
              linear_app_grant: JSON.stringify({
                kind: "oauth",
                accessToken: "renewed-access",
                refreshToken: "renewed-refresh",
                expiresAt: Date.now() + 86_400_000,
                scopes: ["read", "admin"],
              }),
            },
          },
          {
            ...runtime,
            app: { ...runtime.app, accountLabel: "Renewed account" },
          },
        );
      },
    );
    const rejected = expect(edit).rejects.toThrow("changed in another tab");
    pause.release();
    await Promise.all([renewal, rejected]);
    expect(linearGrant(saved.connectionId, "app")?.accessToken).toBe(
      "renewed-access",
    );
    expect(readLinearConnector(saved.connectionId)?.app?.accountLabel).toBe(
      "Renewed account",
    );
    expect(readLinearConnector(saved.connectionId)?.webhook).toBeNull();
  });
});
