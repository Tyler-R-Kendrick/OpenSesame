import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import { performHostedInference } from "../hosted-inference.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "../native-connector-store.js";
import { nativeOAuthGuard } from "../native-oauth-session.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiConnectionDraft } from "./presets.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { AI_CONNECTION_CLASSIFICATION, readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";

const key = "actual-vault-azure-secret";
const replacement = "actual-vault-azure-replacement";
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  vault = await runtimeFixture();
  http = await aiHttpFixture((request, response) => {
    const body = JSON.parse(request.body);
    const responses = request.path.includes("/responses");
    if (body.stream) {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        responses
          ? 'data: {"type":"response.output_text.delta","delta":"Persisted answer"}\n\ndata: {"type":"response.completed"}\n\n'
          : 'data: {"choices":[{"delta":{"content":"Persisted answer"}}]}\n\ndata: [DONE]\n\n',
      );
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          responses
            ? {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [
                      { type: "output_text", text: "Persisted answer" },
                    ],
                  },
                ],
              }
            : { choices: [{ message: { content: "Persisted answer" } }] },
        ),
      );
    }
  });
  releases.push(bindAiConnectionTransport(http.transport));
  releases.push(
    bindHostedModelAuthority({
      fetch,
      assertCurrent: http.transport.assertCurrent,
      read: modelConnection,
      connections: () =>
        readDeviceRows().flatMap((row) => {
          const connection = modelConnection(row.connectionId);
          return connection ? [connection] : [];
        }),
      execute: async () => {
        throw new Error("Azure must use its saved AI runtime.");
      },
    }),
  );
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await http.close();
  await vault.close();
});
function draft(): AiConnectionDraft {
  return {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: http.baseUrl,
    model: "deployment-01",
    apiKey: key,
    azure: { api: "v1", credential: "api-key" },
  };
}
function publicDraft(id: string) {
  const value = readAiConnection(id);
  if (!value) throw new Error("The real saved AI connection is missing.");
  return value;
}
function record(id: string) {
  const value = loadNativeConnectorRecord(id);
  if (!value) throw new Error("The durable native record is missing.");
  return value;
}
function modelConnection(id: string) {
  const view = readNativeConnector(id);
  const value = readAiConnection(id);
  return view && value
    ? {
        connectionId: id,
        providerId: view.providerId,
        status: view.status,
        method: view.configuration.method,
        model: value.model,
        endpoint: value.baseUrl,
      }
    : null;
}
function input(id: string) {
  return {
    model: publicDraft(id).model,
    messages: [{ role: "user" as const, content: "Selected question" }],
    maxOutputTokens: 29,
  };
}
async function selected(id: string) {
  return performHostedInference(id, input(id), {
    fetch,
    assertCurrent: http.transport.assertCurrent,
    signal: http.lifetime.signal,
  });
}
async function edit(
  id: string,
  change: (current: NativeConnectorRecord) => void,
) {
  const current = record(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    AI_CONNECTION_CLASSIFICATION,
    (value) => {
      change(value);
      return value;
    },
  );
}
async function restoreVaultAndLedger() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  expect(readDeviceRows()).toHaveLength(0);
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  await initializeVaultCredentialCustody();
}
function checkWire(index: number, value: AiConnectionDraft, credential = key) {
  const request = http.requests[index];
  if (!request) throw new Error("No owned HTTP request was received.");
  const target = value.azure;
  if (!target) throw new Error("Expected the public Azure target.");
  const relative =
    target.api === "dated-chat"
      ? `deployments/${value.model}/chat/completions?api-version=${target.apiVersion}`
      : `v1/${value.family === "openai_chat" ? "chat/completions" : "responses"}`;
  expect(request.path).toBe(`/custom/v1/openai/${relative}`);
  expect(request.headers["api-key"]).toBe(
    target.credential === "api-key" ? credential : undefined,
  );
  expect(request.headers.authorization).toBe(
    target.credential === "entra-token" ? `Bearer ${credential}` : undefined,
  );
  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body).model).toBe(value.model);
}

const cases = (["openai_chat", "openai_responses"] as const).flatMap((family) =>
  (["api-key", "entra-token"] as const).map((credential) => ({
    family,
    credential,
  })),
);
it.each(cases)(
  "restores $family $credential and consumes its actual saved inference",
  async ({ family, credential }) => {
    const value = {
      ...draft(),
      family,
      azure: { api: "v1", credential } as const,
    };
    await expect(testAiConnection(value)).resolves.toBe(
      "Model inference verified",
    );
    expect(readDeviceRows()).toHaveLength(0);
    expect(vaultStore.getSnapshot().items).toHaveLength(0);
    const saved = await saveAiConnection(value);
    expect(saved.status).toBe("connected");
    expect(http.requests).toHaveLength(2);
    const encoded = `{"api":"v1","credential":"${credential}"}`;
    expect(
      record(saved.connectionId).configuration.parameters.azure_target,
    ).toBe(encoded);
    expect(publicDraft(saved.connectionId)).toMatchObject({
      azure: value.azure,
      apiKey: "",
    });
    expect(vaultStore.getSnapshot().items).toMatchObject([
      { kind: "credential", method: { type: "token", token: key } },
    ]);
    await restoreVaultAndLedger();
    expect(publicDraft(saved.connectionId).azure).toEqual(value.azure);
    expect(
      record(saved.connectionId).configuration.parameters.azure_target,
    ).toBe(encoded);
    await expect(selected(saved.connectionId)).resolves.toMatchObject({
      answer: "Persisted answer",
    });
    const chunks: string[] = [];
    await expect(
      performSavedAiInference(
        saved.connectionId,
        input(saved.connectionId),
        undefined,
        (text) => chunks.push(text),
      ),
    ).resolves.toMatchObject({ answer: "Persisted answer" });
    expect(chunks).toEqual(["Persisted answer"]);
    expect(http.requests).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) checkWire(index, value);
    expect(JSON.parse(http.requests[2]?.body ?? "{}")).toMatchObject(
      family === "openai_chat"
        ? { max_completion_tokens: 29, stream: false }
        : { max_output_tokens: 29, stream: false },
    );
    expect(JSON.parse(http.requests[3]?.body ?? "{}").stream).toBe(true);
    expect(JSON.stringify(readDeviceRows())).not.toContain(key);
    expect(JSON.stringify(readDeviceSecrets())).not.toContain(key);
    expect([...vault.files.values()].join()).not.toContain(key);
    await deleteAiConnection(saved.connectionId);
    expect(readDeviceRows()).toHaveLength(0);
    expect(vaultStore.getSnapshot().items).toHaveLength(0);
  },
);

it("retains only an unchanged target key and verifies an explicit credential-kind replacement", async () => {
  const saved = await saveAiConnection(draft());
  const original = publicDraft(saved.connectionId);
  await saveAiConnection(
    { ...original, name: "Renamed Azure" },
    saved.connectionId,
  );
  const before = http.requests.length;
  const unchanged = structuredClone(record(saved.connectionId));
  const edits: Partial<AiConnectionDraft>[] = [
    { azure: undefined },
    {
      azure: {
        api: "dated-chat",
        apiVersion: "2024-06-01",
        credential: "api-key",
      },
    },
    { azure: { api: "v1", credential: "entra-token" } },
    { family: "openai_responses" },
    { model: "other-deployment" },
    { baseUrl: `${http.baseUrl}/other` },
  ];
  for (const change of edits)
    await expect(
      saveAiConnection({ ...original, ...change }, saved.connectionId),
    ).rejects.toThrow(/new API key/);
  expect(http.requests).toHaveLength(before);
  expect(record(saved.connectionId)).toEqual(unchanged);
  const next: AiConnectionDraft = {
    ...original,
    apiKey: replacement,
    azure: { api: "v1", credential: "entra-token" },
  };
  await saveAiConnection(next, saved.connectionId);
  expect(record(saved.connectionId).configuration.fingerprint).not.toBe(
    unchanged.configuration.fingerprint,
  );
  expect(publicDraft(saved.connectionId).azure).toEqual(next.azure);
  checkWire(before, next, replacement);
  await expect(selected(saved.connectionId)).resolves.toMatchObject({
    answer: "Persisted answer",
  });
  expect(vaultStore.getSnapshot().items).toHaveLength(1);
});

it("persists canonical dated metadata and binds an explicit version replacement", async () => {
  const value: AiConnectionDraft = {
    ...draft(),
    azure: {
      credential: "api-key",
      apiVersion: "2024-06-01",
      api: "dated-chat",
    },
  };
  const saved = await saveAiConnection(value);
  const original = record(saved.connectionId).configuration.fingerprint;
  expect(record(saved.connectionId).configuration.parameters.azure_target).toBe(
    '{"api":"dated-chat","apiVersion":"2024-06-01","credential":"api-key"}',
  );
  await restoreVaultAndLedger();
  const next: AiConnectionDraft = {
    ...publicDraft(saved.connectionId),
    azure: {
      api: "dated-chat",
      apiVersion: "2024-10-21",
      credential: "api-key",
    },
  };
  await expect(saveAiConnection(next, saved.connectionId)).rejects.toThrow(
    /new API key/,
  );
  expect(http.requests).toHaveLength(1);
  await saveAiConnection({ ...next, apiKey: replacement }, saved.connectionId);
  expect(record(saved.connectionId).configuration.fingerprint).not.toBe(
    original,
  );
  expect(publicDraft(saved.connectionId).azure).toEqual(next.azure);
  checkWire(1, next, replacement);
  await expect(selected(saved.connectionId)).resolves.toMatchObject({
    answer: "Persisted answer",
  });
  checkWire(2, next, replacement);
});

it("rejects corrupt durable Azure target JSON rather than falling back to generic OpenAI", async () => {
  const saved = await saveAiConnection(draft());
  const corrupt = [
    "",
    " ",
    "null",
    "[]",
    "{",
    '"v1"',
    "x".repeat(513),
    '{"api":"v2","credential":"api-key"}',
    '{"api":"v1","credential":"api-key","token":"private-raw-target"}',
  ];
  for (const azure_target of corrupt) {
    await edit(saved.connectionId, (current) => {
      current.configuration.parameters.azure_target = azure_target;
    });
    expect(() => readAiConnection(saved.connectionId)).toThrow(
      /saved Azure target is invalid/,
    );
    await expect(selected(saved.connectionId)).rejects.toThrow(
      /saved Azure target is invalid/,
    );
    expect(http.requests).toHaveLength(1);
  }
});

it.each(["reference", "digest", "edited Token", "trashed Token", "lock"])(
  "refuses %s without another actual inference",
  async (change) => {
    const saved = await saveAiConnection(draft());
    if (change === "reference" || change === "digest")
      await edit(saved.connectionId, (current) => {
        const field =
          change === "reference"
            ? "ai_credential_reference"
            : "ai_credential_digest";
        current.privateState.credentials[field] =
          "tampered-reference-or-digest";
      });
    else if (change === "lock") vaultStore.lock();
    else {
      const item = vaultStore.getSnapshot().items[0];
      if (!item || item.kind !== "credential" || item.method.type !== "token")
        throw new Error("The actual vault Token is missing.");
      if (change === "trashed Token") await vaultStore.trashItem(item.id);
      else
        await vaultStore.saveItem({
          ...item,
          method: { ...item.method, token: replacement },
        });
    }
    await expect(selected(saved.connectionId)).rejects.toThrow();
    expect(http.requests).toHaveLength(1);
  },
);
