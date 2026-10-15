import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "../native-connector-store.js";
import { nativeKeyBinding } from "../native-key-state.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { itemText } from "../vault/item-departure.js";
import { vaultStore } from "../vault/store.js";
import { aiConnectionDraft } from "./presets.js";
import { aiConnectionProjection } from "./projection.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import { deleteAiConnection, saveAiConnection } from "./runtime.js";
import { AI_CONNECTION_CLASSIFICATION } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";

let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let release = () => {};
let allowed = true;
let status = 200;
let malformed = false;
const key = "actual-vault-bound-projection-token";
beforeEach(async () => {
  vault = await runtimeFixture();
  allowed = true;
  status = 200;
  malformed = false;
  http = await aiHttpFixture((_request, response) => {
    response.statusCode = status;
    response.end(
      JSON.stringify(
        malformed ? {} : { choices: [{ message: { content: "OK" } }] },
      ),
    );
  });
  release = bindAiConnectionTransport({
    ...http.transport,
    assertEndpointAllowed(endpoint) {
      expect(endpoint).toBe(http.baseUrl);
      if (!allowed) throw new Error("Configured endpoint withdrawn");
    },
  });
});
afterEach(async () => {
  release();
  await http.close();
  await vault.close();
});
function draft() {
  return {
    ...aiConnectionDraft("nvidia"),
    baseUrl: http.baseUrl,
    model: "fixture-model",
    apiKey: key,
  };
}
async function edit(
  id: string,
  change: (record: NativeConnectorRecord) => void,
) {
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Missing real saved AI proof");
  await updateNativeConnector(
    id,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    AI_CONNECTION_CLASSIFICATION,
    (current) => {
      change(current);
      return current;
    },
  );
}

it("projects actual configured inference and sealed credential ownership without exposing the token", async () => {
  const saved = await saveAiConnection(draft());
  expect(http.requests).toHaveLength(1);
  expect(http.requests[0]?.path).toBe("/custom/v1/chat/completions");
  expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${key}`);
  expect(aiConnectionProjection(saved.connectionId)).toBe("verified");
  expect(JSON.stringify(readDeviceRows())).not.toContain(key);
  expect(JSON.stringify(readDeviceSecrets())).not.toContain(key);
  expect([...vault.files.values()].join()).not.toContain(key);
  expect(http.requests).toHaveLength(1);
});

it.each(["refused", "malformed"])(
  "never invents a proof from %s inference",
  async (failure) => {
    status = failure === "refused" ? 401 : 200;
    malformed = failure === "malformed";
    await expect(saveAiConnection(draft())).rejects.toThrow();
    expect(readDeviceRows()).toEqual([]);
  },
);

const changes: readonly [string, (record: NativeConnectorRecord) => void][] = [
  [
    "missing verification",
    (record) => {
      record.privateState.verification = null;
    },
  ],
  [
    "stale verification",
    (record) => {
      if (record.privateState.verification)
        record.privateState.verification.fingerprint = "f".repeat(64);
    },
  ],
  [
    "expired grant",
    (record) => {
      const grant = record.privateState.grants.app;
      const metadata = record.runtime.grants[0];
      if (!grant || !metadata) throw new Error("Missing real grant");
      grant.expiresAt = 1;
      metadata.expiresAt = 1;
    },
  ],
  [
    "withdrawn grant",
    (record) => {
      const metadata = record.runtime.grants[0];
      if (metadata) metadata.needsReauth = true;
    },
  ],
  [
    "changed endpoint",
    (record) => {
      record.configuration.parameters.base_url = "https://changed.example/v1";
    },
  ],
  [
    "changed model",
    (record) => {
      record.configuration.parameters.model = "different-model";
    },
  ],
  [
    "changed authentication",
    (record) => {
      record.configuration.parameters.authentication = "none";
    },
  ],
  [
    "unknown AI contract",
    (record) => {
      record.configuration.parameters.ai_contract = "unverified-contract";
    },
  ],
  [
    "malformed protocol",
    (record) => {
      record.configuration.parameters.family = "invented-protocol";
    },
  ],
  [
    "changed credential binding",
    (record) => {
      record.privateState.credentials.ai_credential_reference =
        "%invalid-reference";
      const grant = record.privateState.grants.app;
      if (grant)
        grant.accessToken = nativeKeyBinding(
          AI_CONNECTION_CLASSIFICATION,
          record.privateState.credentials,
        );
    },
  ],
  [
    "changed credential digest",
    (record) => {
      record.privateState.credentials.ai_credential_digest = "f".repeat(64);
      const grant = record.privateState.grants.app;
      if (grant)
        grant.accessToken = nativeKeyBinding(
          AI_CONNECTION_CLASSIFICATION,
          record.privateState.credentials,
        );
    },
  ],
  [
    "cleanup",
    (record) => {
      record.privateState.recovery.push({
        id: "cleanup",
        providerId: "nvidia",
        actor: "app",
        fingerprint: record.configuration.fingerprint,
        kind: "revoke",
        targetId: record.configuration.targetIds.endpoint ?? "",
      });
    },
  ],
];
it.each(changes)(
  "keeps %s pending without another provider request",
  async (_name, change) => {
    const saved = await saveAiConnection(draft());
    await edit(saved.connectionId, change);
    expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
    expect(http.requests).toHaveLength(1);
  },
);

it.each(["guest", "wrong vault", "second step"])(
  "refuses an otherwise valid proof in %s state",
  async (state) => {
    const saved = await saveAiConnection(draft());
    const snapshot = vaultStore.getSnapshot();
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      guest: state === "guest",
      tomb: state === "wrong vault" ? "other-vault" : snapshot.tomb,
      awaitingSecondStep: state === "second step",
    });
    expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
    vi.restoreAllMocks();
  },
);

it("refuses a real vault lock", async () => {
  const saved = await saveAiConnection(draft());
  vaultStore.lock();
  expect(aiConnectionProjection(saved.connectionId)).not.toBe("verified");
});
it("refuses an actually withdrawn vault token", async () => {
  const saved = await saveAiConnection(draft());
  const item = vaultStore.getSnapshot().items[0];
  if (!item) throw new Error("Missing saved Token credential");
  await vaultStore.withdrawItems({
    items: { [item.id]: itemText(item) },
    folderIds: [],
  });
  expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
});
it.each(["edit", "trash", "purge"])(
  "refuses a real token %s after inference",
  async (change) => {
    const saved = await saveAiConnection(draft());
    const item = vaultStore.getSnapshot().items[0];
    if (!item || item.kind !== "credential" || item.method.type !== "token")
      throw new Error("Missing saved Token credential");
    if (change === "edit")
      await vaultStore.saveItem({
        ...item,
        method: { ...item.method, token: "edited-vault-token" },
      });
    else await vaultStore.trashItem(item.id);
    if (change === "purge") await vaultStore.purgeItem(item.id);
    expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
    expect(http.requests).toHaveLength(1);
  },
);
it.each(["endpoint", "lease", "admission missing"])(
  "requires current %s authority",
  async (withdraw) => {
    const saved = await saveAiConnection(draft());
    if (withdraw === "endpoint") allowed = false;
    if (withdraw === "lease") http.lifetime.abort();
    const remove =
      withdraw === "admission missing"
        ? bindAiConnectionTransport(http.transport)
        : () => {};
    expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
    remove();
  },
);
it("forgets the proof with its exact vault credential", async () => {
  const saved = await saveAiConnection(draft());
  await deleteAiConnection(saved.connectionId);
  expect(aiConnectionProjection(saved.connectionId)).toBe("ordinary");
});
it("checks owner, fingerprint and endpoint even for keyless inference", async () => {
  const saved = await saveAiConnection({
    ...draft(),
    authentication: "none",
    apiKey: "",
  });
  expect(aiConnectionProjection(saved.connectionId)).toBe("verified");
  allowed = false;
  expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
  allowed = true;
  await edit(saved.connectionId, (record) => {
    record.configuration.parameters.model = "changed";
  });
  expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
});

it("rejects replacement of the captured AI authority during endpoint admission", async () => {
  const saved = await saveAiConnection(draft());
  let newerRelease = () => {};
  const newer = {
    ...http.transport,
    assertEndpointAllowed: () => {
      throw new Error("New endpoint denied");
    },
  };
  const olderRelease = bindAiConnectionTransport({
    ...http.transport,
    assertEndpointAllowed: () => {
      newerRelease = bindAiConnectionTransport(newer);
    },
  });
  expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
  olderRelease();
  expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
  expect(http.requests).toHaveLength(1);
  newerRelease();
});

it.each(["edit", "remove"])(
  "rejects a token %s during final endpoint admission",
  async (change) => {
    const saved = await saveAiConnection(draft());
    const snapshot = vaultStore.getSnapshot();
    const items = structuredClone(snapshot.items);
    const item = items[0];
    if (!item || item.kind !== "credential" || item.method.type !== "token")
      throw new Error("Missing real token credential");
    item.method.token = "changed-after-capture";
    let admissions = 0;
    const remove = bindAiConnectionTransport({
      ...http.transport,
      assertEndpointAllowed() {
        admissions += 1;
        if (admissions === 2)
          vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
            ...snapshot,
            items: change === "edit" ? items : [],
          });
      },
    });
    expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
    expect(http.requests).toHaveLength(1);
    remove();
    vi.restoreAllMocks();
  },
);
