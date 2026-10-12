import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvForgetAll, kvGet, kvSeams } from "./kv.js";
import {
  beginLinearAuthorization,
  configureLinearConnector,
  finishLinearAuthorization,
} from "./linear-connectors.js";
import { cleanupRejectedLinearGrant } from "./linear-rejected-grant.js";
import { revokeLinearConnector } from "./linear-revoke.js";
import {
  installLinearRuntimeTests,
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  pendingLinear,
} from "./linear-runtime.test-support.js";

installLinearRuntimeTests();
const rejected = {
  accessToken: "rejected-access",
  refreshToken: "rejected-refresh",
  expiresAt: Date.now() + 86_400_000,
  scopes: ["read"],
};

/** A fresh reader sees only the bytes that the durable port committed. */
function reloadCommittedSnapshot(): void {
  const snapshot = new Map<string, string | null>(
    DEVICE_CONNECTOR_KEYS.map((key) => [key, kvGet(key)]),
  );
  kvForgetAll();
  vi.mocked(kvSeams.kvGet).mockImplementation(
    (key) => snapshot.get(key) ?? null,
  );
  vi.mocked(kvSeams.kvSetDurable).mockImplementation(async (key, value) => {
    snapshot.set(key, value);
  });
}

async function failedConsent() {
  const saved = await configureLinearConnector(
    linearDraft("oauth"),
    linearOptions,
  );
  const pending = pendingLinear(saved.connectionId);
  linearAnswers(
    { body: linearToken },
    {
      body: {
        data: {
          ...linearAccount,
          organization: {
            id: "other-workspace",
            name: "Other",
            urlKey: "other",
          },
        },
      },
    },
    { body: {}, status: 503 },
  );
  await expect(
    finishLinearAuthorization(
      `?linear_state=${pending.state}&linear_code=rejected`,
    ),
  ).rejects.toThrow("cleanup failed");
  return saved.connectionId;
}

describe("durable compensation of rejected Linear consent", () => {
  it("retains a wrong-workspace grant across rehydration and cleans it before reconnecting without a verified identity", async () => {
    const id = await failedConsent();
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toContain(
      "private-access",
    );
    expect(JSON.stringify(readDeviceRows())).not.toContain("private-access");
    reloadCommittedSnapshot();
    expect(deviceConnection(id)?.status).toBe("pending");
    const provider = linearAnswers({ body: null }, { body: null });
    await beginLinearAuthorization(id, "app");
    expect(readDeviceSecrets()[id]?.linear_cleanup_app).toBeUndefined();
    expect(pendingLinear(id).actor).toBe("app");
    const tokens = provider.mock.calls.map(([, init]) =>
      new URLSearchParams(String(init?.body)).get("token"),
    );
    expect(tokens).toEqual(["private-refresh", "private-access"]);
  });

  it("cleans rejected consent after rehydration before disconnect deletes its sealed record", async () => {
    const id = await failedConsent();
    reloadCommittedSnapshot();
    const provider = linearAnswers({ body: null }, { body: null });
    await revokeLinearConnector(id);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(deviceConnection(id)).toBeNull();
    expect(readDeviceSecrets()[id]).toBeUndefined();
  });

  it("seals a compensation refresh rotation before subsequent cleanup fails and retries both pairs", async () => {
    const saved = await configureLinearConnector(
      linearDraft("oauth"),
      linearOptions,
    );
    linearAnswers(
      { body: {}, status: 400 },
      {
        body: {
          ...linearToken,
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
        },
      },
      { body: null },
      { body: {}, status: 503 },
    );
    await expect(
      cleanupRejectedLinearGrant(
        saved.connectionId,
        "app",
        rejected,
        "client-1",
      ),
    ).rejects.toMatchObject({ status: 503 });
    reloadCommittedSnapshot();
    const queue = readDeviceSecrets()[saved.connectionId]?.linear_cleanup_app;
    expect(queue).toContain("rejected-access");
    expect(queue).toContain("rotated-refresh");
    expect(JSON.stringify(readDeviceRows())).not.toContain("rotated-refresh");
    linearAnswers(
      { body: {}, status: 400 },
      { body: { error: "invalid_grant" }, status: 400 },
      { body: {}, status: 400 },
      { body: {}, status: 401 },
      { body: null },
      { body: null },
    );
    await revokeLinearConnector(saved.connectionId);
    expect(readDeviceSecrets()[saved.connectionId]).toBeUndefined();
  });
});
