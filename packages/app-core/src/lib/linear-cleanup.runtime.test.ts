import { describe, expect, it, vi } from "vitest";
import { readDeviceSecrets } from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import { linearApiSeams } from "./linear-api.js";
import { retainCleanupGrant } from "./linear-cleanup-queue.js";
import {
  configureLinearConnector,
  finishLinearAuthorization,
} from "./linear-connectors.js";
import { cleanupRejectedLinearGrant } from "./linear-rejected-grant.js";
import { removeLinearActor, revokeLinearConnector } from "./linear-revoke.js";
import {
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
  readLinearConnector,
  updateLinearRecord,
} from "./linear-store.js";

installLinearRuntimeTests();
async function authorized(user = false) {
  const saved = await configureLinearConnector(linearDraft("oauth"), {
    ...linearOptions,
    userScopes: user ? ["read"] : [],
  });
  const pending = pendingLinear(saved.connectionId);
  linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
  await finishLinearAuthorization(
    `?linear_state=${pending.state}&linear_code=app`,
  );
  if (user) {
    const next = pendingLinear(saved.connectionId);
    linearAnswers(
      {
        body: {
          ...linearToken,
          access_token: "user-access",
          refresh_token: "user-refresh",
        },
      },
      { body: { data: linearAccount } },
    );
    await finishLinearAuthorization(
      `?linear_state=${next.state}&linear_code=user`,
    );
  }
  return saved.connectionId;
}
function pauseRevoke(token: string) {
  const provider = linearApiSeams.fetch;
  let entered = () => {};
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  linearApiSeams.fetch = vi.fn(async (url, init) => {
    if (
      String(url).endsWith("/oauth/revoke") &&
      new URLSearchParams(String(init?.body)).get("token") === token
    ) {
      entered();
      await resumed;
    }
    return provider(url, init);
  });
  return { waiting, release };
}

describe("cleanup rotation durability and exact deletion", () => {
  it("compensates an unjournaled rotation immediately and preserves the original durable obligation for retry", async () => {
    const id = await authorized();
    const durable = vi.mocked(kvSeams.kvSetDurable).getMockImplementation();
    if (!durable) throw new Error("Durable test port required");
    vi.mocked(kvSeams.kvSetDurable).mockImplementation(async (key, value) => {
      if (value.includes("unpersisted-refresh"))
        throw new Error("Rotation write failed");
      await durable(key, value);
    });
    const provider = linearAnswers(
      { body: {}, status: 400 },
      {
        body: {
          ...linearToken,
          access_token: "unpersisted-access",
          refresh_token: "unpersisted-refresh",
        },
      },
      { body: null },
      { body: null },
    );
    await expect(removeLinearActor(id, "app")).rejects.toThrow(
      "Rotation write failed",
    );
    const queue = readDeviceSecrets()[id]?.linear_cleanup_app;
    expect(queue).toContain("private-refresh");
    expect(queue).not.toContain("unpersisted-refresh");
    expect(
      provider.mock.calls
        .slice(2)
        .map(([, init]) =>
          new URLSearchParams(String(init?.body)).get("token"),
        ),
    ).toEqual(["unpersisted-refresh", "unpersisted-access"]);
    expect(deviceConnection(id)?.status).toBe("pending");
    linearAnswers(
      { body: {}, status: 400 },
      { body: { error: "invalid_grant" }, status: 400 },
      { body: {}, status: 400 },
      { body: {}, status: 401 },
    );
    await removeLinearActor(id, "app");
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toBeUndefined();
    expect(linearGrant(id, "app")).toBeNull();
  });

  it("commits the rotated pair before the next provider revocation begins", async () => {
    const id = await authorized();
    linearAnswers(
      { body: {}, status: 400 },
      {
        body: {
          ...linearToken,
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
        },
      },
      { body: null },
      { body: null },
      { body: null },
    );
    const paused = pauseRevoke("fresh-refresh");
    const cleanup = removeLinearActor(id, "app");
    await paused.waiting;
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toContain(
      "private-refresh",
    );
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toContain(
      "fresh-refresh",
    );
    expect(deviceConnection(id)?.status).toBe("pending");
    paused.release();
    await cleanup;
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toBeUndefined();
    expect(linearGrant(id, "app")).toBeNull();
  });

  it("preserves a concurrently replaced primary refresh pair even when its access token is unchanged", async () => {
    const id = await authorized();
    const before = linearGrant(id, "app");
    if (!before) throw new Error("Grant required");
    linearAnswers({ body: null }, { body: null });
    const paused = pauseRevoke("private-access");
    const cleanup = removeLinearActor(id, "app");
    const rejected = expect(cleanup).rejects.toThrow("authorization changed");
    await paused.waiting;
    await updateLinearRecord(id, async (record) => ({
      ...record,
      secrets: {
        ...record.secrets,
        linear_app_grant: JSON.stringify({
          ...before,
          refreshToken: "replacement-refresh",
        }),
      },
    }));
    paused.release();
    await rejected;
    expect(linearGrant(id, "app")?.refreshToken).toBe("replacement-refresh");
    expect(deviceConnection(id)).not.toBeNull();
  });

  it("refuses the final disconnect tombstone if new app consent was saved while user cleanup ran", async () => {
    const id = await authorized(true);
    const app = readLinearConnector(id)?.app;
    if (!app) throw new Error("Identity required");
    linearAnswers(
      { body: null },
      { body: null },
      { body: null },
      { body: null },
    );
    const paused = pauseRevoke("user-refresh");
    const disconnect = revokeLinearConnector(id);
    const rejected = expect(disconnect).rejects.toThrow(
      "configuration changed during disconnect",
    );
    await paused.waiting;
    await updateLinearRecord(id, async (record, runtime) =>
      linearPublicRecord(
        {
          ...record,
          secrets: {
            ...record.secrets,
            linear_app_grant: JSON.stringify({
              kind: "oauth",
              accessToken: "new-app-access",
              refreshToken: "new-app-refresh",
              expiresAt: Date.now() + 86400000,
              scopes: ["read"],
            }),
          },
        },
        { ...runtime, app },
      ),
    );
    paused.release();
    await rejected;
    expect(linearGrant(id, "app")?.accessToken).toBe("new-app-access");
    expect(deviceConnection(id)).not.toBeNull();
  });

  it("removes only the exact compensated pair and retains the same-access pair with a different refresh token", async () => {
    const saved = await configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
    );
    const grant = {
      accessToken: "rejected-access",
      expiresAt: Date.now() + 86400000,
      scopes: ["read"],
      refreshToken: "rejected-refresh",
    };
    linearAnswers({ body: null }, { body: null });
    const paused = pauseRevoke(grant.accessToken);
    const cleanup = cleanupRejectedLinearGrant(
      saved.connectionId,
      "app",
      grant,
      "client-1",
    );
    await paused.waiting;
    await retainCleanupGrant(saved.connectionId, "app", {
      kind: "oauth",
      ...grant,
      refreshToken: "replacement-refresh",
    });
    paused.release();
    await cleanup;
    const queue = readDeviceSecrets()[saved.connectionId]?.linear_cleanup_app;
    expect(queue).toContain("replacement-refresh");
    expect(queue).not.toContain("rejected-refresh");
    expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
  });
});
