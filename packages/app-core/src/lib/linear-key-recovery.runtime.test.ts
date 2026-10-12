import { describe, expect, it, vi } from "vitest";
import { readDeviceSecrets } from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvSeams } from "./kv.js";
import { linearApiSeams } from "./linear-api.js";
import {
  configureLinearConnector,
  readLinearConnector,
} from "./linear-connectors.js";
import {
  recoveryOptions,
  recoveryRequest,
  recoveryResponse,
} from "./linear-recovery.test-support.js";
import {
  installLinearProvider,
  installLinearRuntimeTests,
  linearAccount,
  linearDraft,
} from "./linear-runtime.test-support.js";
import { linearGrant } from "./linear-store.js";

installLinearRuntimeTests();
async function keyFixture(pendingHook = false) {
  const provider = installLinearProvider();
  if (pendingHook)
    provider.onCreate = () =>
      vi
        .mocked(kvSeams.kvSetDurable)
        .mockRejectedValueOnce(new Error("Hook completion failed"));
  const configure = configureLinearConnector(linearDraft(), recoveryOptions);
  let id = "";
  if (pendingHook) {
    await configure.catch(() => undefined);
    id = Object.keys(readDeviceSecrets())[0] ?? "";
    if (!readDeviceSecrets()[id]?.linear_webhook_intent)
      throw new Error("Pending hook required");
  } else id = (await configure).connectionId;
  provider.onCreate = () => {};
  const actualFetch = linearApiSeams.fetch;
  const cleanupActors: string[] = [];
  const fixture = {
    provider,
    id,
    wrongWorkspace: false,
    oldInvalid: true,
    cleanupActors,
  };
  linearApiSeams.fetch = vi.fn(async (url, init) => {
    const token = new Headers(init?.headers).get("authorization") ?? "";
    if (token === "private-api-key" && fixture.oldInvalid)
      return recoveryResponse({}, 401);
    const query = recoveryRequest(init);
    if (
      query.includes("OpenSesameWebhooks") ||
      query.includes("OpenSesameDeleteWebhook")
    )
      fixture.cleanupActors.push(token);
    if (
      token === "replacement-api-key" &&
      query.includes("OpenSesameAccount") &&
      fixture.wrongWorkspace
    )
      return recoveryResponse({
        data: {
          ...linearAccount,
          organization: {
            id: "different-workspace",
            name: "Different",
            urlKey: "different",
          },
        },
      });
    return actualFetch(url, init);
  });
  return fixture;
}

describe("verified API-key replacement webhook cleanup", () => {
  it.each([false, true])(
    "replaces an invalid old key using the verified same-workspace key (pending=%s)",
    async (pendingHook) => {
      const fixture = await keyFixture(pendingHook);
      const connected = await configureLinearConnector(
        { ...linearDraft(), key: "replacement-api-key" },
        recoveryOptions,
        fixture.id,
      );
      expect(connected.status).toBe("active");
      expect(linearGrant(fixture.id, "app")?.accessToken).toBe(
        "replacement-api-key",
      );
      expect(fixture.cleanupActors).toEqual([
        "replacement-api-key",
        "replacement-api-key",
      ]);
      expect(fixture.provider.deleted).toEqual([fixture.provider.created[0]]);
      expect(fixture.provider.created).toHaveLength(2);
      expect(fixture.provider.hooks.size).toBe(1);
      expect(readLinearConnector(fixture.id)?.webhook?.id).toBe(
        fixture.provider.created[1],
      );
    },
  );

  it("never uses a new key from another workspace to clean up the original webhook", async () => {
    const fixture = await keyFixture();
    fixture.wrongWorkspace = true;
    await expect(
      configureLinearConnector(
        { ...linearDraft(), key: "replacement-api-key" },
        recoveryOptions,
        fixture.id,
      ),
    ).rejects.toMatchObject({ code: "authorization" });
    expect(fixture.cleanupActors).toHaveLength(0);
    expect(linearGrant(fixture.id, "app")?.accessToken).toBe("private-api-key");
    expect(fixture.provider.deleted).toHaveLength(0);
    expect(fixture.provider.hooks.size).toBe(1);
  });

  it("uses a healthy original key to remove its subscription before moving to a different workspace", async () => {
    const fixture = await keyFixture();
    fixture.oldInvalid = false;
    fixture.wrongWorkspace = true;
    await configureLinearConnector(
      { ...linearDraft(), key: "replacement-api-key" },
      { ...recoveryOptions, webhookEnabled: false },
      fixture.id,
    );
    expect(fixture.cleanupActors).toEqual([
      "private-api-key",
      "private-api-key",
    ]);
    expect(fixture.provider.hooks.size).toBe(0);
    expect(readLinearConnector(fixture.id)?.app?.workspaceId).toBe(
      "different-workspace",
    );
    expect(deviceConnection(fixture.id)?.status).toBe("active");
  });
});
