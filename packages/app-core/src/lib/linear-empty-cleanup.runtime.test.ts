import { describe, expect, it } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import {
  configureLinearConnector,
  finishLinearAuthorization,
  linearActorCleanupPending,
  retryLinearActorCleanup,
} from "./linear-connectors.js";
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
  updateLinearRecord,
} from "./linear-store.js";

installLinearRuntimeTests();
async function verifiedApp() {
  const saved = await configureLinearConnector(
    linearDraft("oauth"),
    linearOptions,
  );
  const pending = pendingLinear(saved.connectionId);
  linearAnswers({ body: linearToken }, { body: { data: linearAccount } });
  await finishLinearAuthorization(
    `?linear_state=${pending.state}&linear_code=valid`,
  );
  return saved.connectionId;
}
async function retainUnselectedUser(id: string) {
  await updateLinearRecord(id, async (record, runtime) =>
    linearPublicRecord(
      {
        ...record,
        secrets: {
          ...record.secrets,
          linear_cleanup_user: JSON.stringify([
            {
              kind: "oauth",
              accessToken: "stranded-access",
              refreshToken: "stranded-refresh",
              expiresAt: Date.now() + 86_400_000,
              scopes: ["read"],
            },
          ]),
        },
      },
      runtime,
    ),
  );
}
describe("reachable cleanup for unselected Linear actors", () => {
  it("keeps a rejected unselected grant inactive and retries cleanup without obtaining unwanted consent", async () => {
    const id = await verifiedApp();
    await retainUnselectedUser(id);
    expect(linearActorCleanupPending(id, "user")).toBe(true);
    expect(deviceConnection(id)?.status).toBe("pending");
    expect(JSON.stringify(readDeviceRows())).not.toContain("stranded-access");
    const provider = linearAnswers({ body: null }, { body: null });
    const connected = await retryLinearActorCleanup(id, "user");
    expect(connected.status).toBe("active");
    expect(linearActorCleanupPending(id, "user")).toBe(false);
    expect(readDeviceSecrets()[id]?.linear_pending).toBeUndefined();
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    expect(
      provider.mock.calls.map(([, init]) =>
        new URLSearchParams(String(init?.body)).get("token"),
      ),
    ).toEqual(["stranded-refresh", "stranded-access"]);
  });
  it("requires reconnecting selected actors instead of treating their consent as unselected cleanup", async () => {
    const id = await verifiedApp();
    await expect(retryLinearActorCleanup(id, "app")).rejects.toThrow(
      "Reconnect the selected Linear account",
    );
    expect(linearGrant(id, "app")?.accessToken).toBe("private-access");
    expect(deviceConnection(id)?.status).toBe("active");
  });
});
