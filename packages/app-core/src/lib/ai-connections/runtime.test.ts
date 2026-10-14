import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import { performHostedInference } from "../hosted-inference.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import {
  MODEL_TEST_SECRET,
  saveModelFixture,
} from "../hosted-model.test-support.js";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { aiConnectionDraft } from "./presets.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let release = () => {};
let lifetime: AbortController;
const key = "private-actual-vault-ai-token";
const draft = () => ({
  ...aiConnectionDraft("byo-ai"),
  baseUrl: "https://models.example/custom/v1",
  model: "test-model",
  apiKey: key,
});
const answer = () =>
  Response.json({ choices: [{ message: { content: "Model answer" } }] });
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
  lifetime = new AbortController();
  fetcher = vi.fn(async () => answer());
  release = bindAiConnectionTransport({
    fetch: fetcher,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  });
});
afterEach(async () => {
  release();
  lifetime.abort();
  await fixture.close();
});

it("probes without saving; saving stores a real Token credential and metadata-only reference", async () => {
  await expect(testAiConnection(draft())).resolves.toBe(
    "Model inference verified",
  );
  expect(readDeviceRows()).toHaveLength(0);
  expect(vaultStore.getSnapshot().items).toHaveLength(0);
  const saved = await saveAiConnection(draft());
  expect(saved.status).toBe("connected");
  expect(readAiConnection(saved.connectionId)?.apiKey).toBe("");
  const items = vaultStore.getSnapshot().items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "credential",
    method: { type: "token", token: key },
  });
  const record = loadNativeConnectorRecord(saved.connectionId);
  expect(record?.privateState.credentials.ai_credential_reference).toBeTruthy();
  expect(JSON.stringify(readDeviceRows())).not.toContain(key);
  expect(JSON.stringify(readDeviceSecrets())).not.toContain(key);
  expect([...fixture.files.values()].join()).not.toContain(key);
});

it("runs the saved endpoint through the existing hosted inference entry and forgets its exact credential", async () => {
  const saved = await saveAiConnection(draft());
  const releaseAuthority = bindHostedModelAuthority({
    fetch: fetcher,
    assertCurrent: vi.fn(),
    read: () => ({
      connectionId: saved.connectionId,
      providerId: "byo-ai",
      method: "api-key",
      status: "connected",
      model: "test-model",
      endpoint: draft().baseUrl,
    }),
    connections: () => [],
    execute: vi.fn(),
  });
  try {
    const result = await performHostedInference(
      saved.connectionId,
      {
        model: "test-model",
        messages: [{ role: "user", content: "Question" }],
      },
      { fetch: fetcher, assertCurrent: vi.fn(), signal: lifetime.signal },
    );
    expect(result.answer).toBe("Model answer");
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "https://models.example/custom/v1/chat/completions",
    );
    await deleteAiConnection(saved.connectionId);
    expect(readDeviceRows()).toHaveLength(0);
    expect(vaultStore.getSnapshot().items).toHaveLength(0);
  } finally {
    releaseAuthority();
  }
});

it("retains an unchanged target key, but never forwards it to an edited endpoint", async () => {
  const saved = await saveAiConnection(draft());
  const unchanged = { ...draft(), apiKey: "", name: "Renamed model" };
  await saveAiConnection(unchanged, saved.connectionId);
  expect(vaultStore.getSnapshot().items).toHaveLength(1);
  const before = fetcher.mock.calls.length;
  await expect(
    saveAiConnection(
      { ...unchanged, baseUrl: "https://other.example/v1" },
      saved.connectionId,
    ),
  ).rejects.toThrow(/new API key/);
  expect(fetcher.mock.calls).toHaveLength(before);
});

it("rejects after vault lock before another request can leave", async () => {
  const saved = await saveAiConnection(draft());
  vaultStore.lock();
  await expect(
    performSavedAiInference(saved.connectionId, {
      model: "test-model",
      messages: [{ role: "user", content: "Question" }],
    }),
  ).rejects.toThrow(/Unlock/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("requires re-verification when the actual vault token changes behind its saved reference", async () => {
  const saved = await saveAiConnection(draft());
  const token = vaultStore.getSnapshot().items[0];
  if (!token || token.kind !== "credential" || token.method.type !== "token")
    throw new Error("Missing actual Token credential");
  await vaultStore.saveItem({
    ...token,
    method: { ...token.method, token: "replacement-not-yet-verified" },
  });
  await expect(
    performSavedAiInference(saved.connectionId, {
      model: "test-model",
      messages: [{ role: "user", content: "Question" }],
    }),
  ).rejects.toThrow(/credential changed/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("upgrades an existing native API-key record in place after explicit credential reentry", async () => {
  const id = await saveModelFixture("openai", true, "legacy-openai");
  const next = {
    ...aiConnectionDraft("openai"),
    model: "test-model",
    apiKey: "",
  };
  await expect(saveAiConnection(next, id)).rejects.toThrow(
    /move this connection/,
  );
  expect(fetcher).not.toHaveBeenCalled();
  const saved = await saveAiConnection({ ...next, apiKey: key }, id);
  expect(saved.connectionId).toBe(id);
  expect(saved.status).toBe("connected");
  expect(readAiConnection(id)?.model).toBe("test-model");
  expect(vaultStore.getSnapshot().items).toHaveLength(1);
  expect(JSON.stringify(readDeviceSecrets())).not.toContain(MODEL_TEST_SECRET);
  expect(JSON.stringify(readDeviceSecrets())).not.toContain(key);
});
