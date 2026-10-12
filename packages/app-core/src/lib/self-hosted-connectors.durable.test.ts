import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDraftState } from "./connect-draft.js";
import { connectPlan } from "./connect-plan.js";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { kvForgetAll, kvSeams } from "./kv.js";
import {
  type SelfHostedConnectorOptions,
  hasSavedSelfHostedCredential,
  readSelfHostedConnector,
  revokeSelfHostedConnectorDurable,
  saveSelfHostedConnectorDurable,
} from "./self-hosted-connectors.js";

const knownPlan = connectPlan("linear");
if (!knownPlan) throw new Error("Linear preset missing");
const plan = knownPlan;
const options: SelfHostedConnectorOptions = {
  mode: "managed",
  workspace: "example",
  appScopes: ["read"],
  userScopes: ["read"],
  webhookResourceTypes: [],
  icon: "",
};
function draft(clientId = "client", clientSecret = "draft-secret") {
  const initial = initialDraftState(plan, "oauth");
  return { ...initial, oauth: { ...initial.oauth, clientId, clientSecret } };
}
beforeEach(kvForgetAll);
afterEach(() => vi.restoreAllMocks());

describe("atomic self-hosted configuration", () => {
  it("keeps the credential draft and publishes no row when storage refuses the commit", async () => {
    const state = draft();
    const write = vi
      .spyOn(kvSeams, "kvSetDurable")
      .mockRejectedValueOnce(new Error("Configuration write failed"));
    await expect(
      saveSelfHostedConnectorDurable(plan, state, options),
    ).rejects.toThrow("Configuration write failed");
    expect(state.oauth.clientSecret).toBe("draft-secret");
    expect(readDeviceRows()).toEqual([]);
    expect(readDeviceSecrets()).toEqual({});
    expect(write).toHaveBeenCalledTimes(1);
    const saved = await saveSelfHostedConnectorDurable(plan, state, options);
    expect(readDeviceRows()).toHaveLength(1);
    expect(Object.keys(readDeviceSecrets())).toEqual([saved.connectionId]);
  });

  it("preserves existing metadata and credentials together after a failed edit", async () => {
    const created = await saveSelfHostedConnectorDurable(
      plan,
      draft(),
      options,
    );
    const previous = readDeviceRows();
    const state = draft("new-client", "new-secret");
    vi.spyOn(kvSeams, "kvSetDurable").mockRejectedValueOnce(
      new Error("Edit write failed"),
    );
    await expect(
      saveSelfHostedConnectorDurable(
        plan,
        state,
        options,
        created.connectionId,
      ),
    ).rejects.toThrow("Edit write failed");
    expect(readDeviceRows()).toEqual(previous);
    expect(readDeviceSecrets()[created.connectionId]).toEqual({
      oauth_client_secret: "draft-secret",
    });
    expect(state.oauth.clientSecret).toBe("new-secret");
    const updated = await saveSelfHostedConnectorDurable(
      plan,
      state,
      options,
      created.connectionId,
    );
    expect(updated.connectionId).toBe(created.connectionId);
    expect(
      readSelfHostedConnector(updated.connectionId)?.state.oauth.clientId,
    ).toBe("new-client");
    expect(readDeviceSecrets()[updated.connectionId]).toEqual({
      oauth_client_secret: "new-secret",
    });
  });

  it("keeps both records and credentials when configurations save concurrently", async () => {
    const original = kvSeams.kvSetDurable;
    vi.spyOn(kvSeams, "kvSetDurable").mockImplementation(async (key, value) => {
      await Promise.resolve();
      return original(key, value);
    });
    const [first, second] = await Promise.all([
      saveSelfHostedConnectorDurable(
        plan,
        draft("first", "first-secret"),
        options,
      ),
      saveSelfHostedConnectorDurable(
        plan,
        draft("second", "second-secret"),
        options,
      ),
    ]);
    expect(readDeviceRows()).toHaveLength(2);
    expect(readDeviceSecrets()[first.connectionId]).toEqual({
      oauth_client_secret: "first-secret",
    });
    expect(readDeviceSecrets()[second.connectionId]).toEqual({
      oauth_client_secret: "second-secret",
    });
  });

  it("rechecks blank credentials after a queued edit changes the application", async () => {
    const created = await saveSelfHostedConnectorDurable(
      plan,
      draft(),
      options,
    );
    const held = readSelfHostedConnector(created.connectionId);
    if (!held) throw new Error("Saved configuration missing");
    const results = await Promise.allSettled([
      saveSelfHostedConnectorDurable(
        plan,
        draft("rotated", "rotated-secret"),
        options,
        created.connectionId,
      ),
      saveSelfHostedConnectorDurable(
        plan,
        held.state,
        options,
        created.connectionId,
      ),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(
      readSelfHostedConnector(created.connectionId)?.state.oauth.clientId,
    ).toBe("rotated");
    expect(readDeviceSecrets()[created.connectionId]).toEqual({
      oauth_client_secret: "rotated-secret",
    });
  });

  it("reports remove failure and retains the configuration until a durable retry succeeds", async () => {
    const saved = await saveSelfHostedConnectorDurable(plan, draft(), options);
    vi.spyOn(kvSeams, "kvSetDurable").mockRejectedValueOnce(
      new Error("Remove write failed"),
    );
    await expect(
      revokeSelfHostedConnectorDurable(saved.connectionId),
    ).rejects.toThrow("Remove write failed");
    expect(readSelfHostedConnector(saved.connectionId)).not.toBeNull();
    expect(readDeviceSecrets()[saved.connectionId]).toEqual({
      oauth_client_secret: "draft-secret",
    });
    await revokeSelfHostedConnectorDurable(saved.connectionId);
    expect(readDeviceRows()).toEqual([]);
    expect(readDeviceSecrets()).toEqual({});
  });

  it("reports a saved credential only for the active compatible method and client", async () => {
    const saved = await saveSelfHostedConnectorDurable(plan, draft(), options);
    const held = readSelfHostedConnector(saved.connectionId);
    if (!held) throw new Error("Saved configuration missing");
    expect(hasSavedSelfHostedCredential(held.state, saved.connectionId)).toBe(
      true,
    );
    expect(
      hasSavedSelfHostedCredential(
        { ...held.state, method: "api-key" },
        saved.connectionId,
      ),
    ).toBe(false);
    expect(
      hasSavedSelfHostedCredential(
        {
          ...held.state,
          oauth: { ...held.state.oauth, clientId: "other-client" },
        },
        saved.connectionId,
      ),
    ).toBe(false);
  });
  it("accepts only constrained raster data URLs for uploaded icons", async () => {
    await expect(
      saveSelfHostedConnectorDurable(plan, draft(), {
        ...options,
        icon: "data:image/svg+xml;base64,PHN2Zz4=",
      }),
    ).rejects.toThrow("Invalid connector options or icon");
    await expect(
      saveSelfHostedConnectorDurable(plan, draft(), {
        ...options,
        icon: "https://example.com/icon.png",
      }),
    ).rejects.toThrow("Invalid connector options or icon");
    const raster = {
      ...options,
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lWQAAAAASUVORK5CYII=",
    };
    const connection = await saveSelfHostedConnectorDurable(
      plan,
      draft(),
      raster,
    );
    expect(readSelfHostedConnector(connection.connectionId)?.options.icon).toBe(
      raster.icon,
    );
  });
});
