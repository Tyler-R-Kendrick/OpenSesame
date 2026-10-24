import { afterEach, expect, it, vi } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "../device-connector-records.js";
import { performHostedInference } from "../hosted-inference.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../kv.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "../native-connector-store.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiDelegationAvailable } from "./delegation.js";
import { aiConnectionDraft } from "./presets.js";
import {
  REPLICATE_TOKEN,
  replicateTlsFixture,
} from "./replicate-tls.test-support.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function selected(id: string) {
  const view = readNativeConnector(id);
  const draft = readAiConnection(id);
  return view && draft
    ? {
        connectionId: id,
        providerId: view.providerId,
        status: view.status,
        method: view.configuration.method,
        model: draft.model,
        endpoint: draft.baseUrl,
      }
    : null;
}
async function setup(provider = "byo-ai") {
  const vault = await runtimeFixture();
  const http = await replicateTlsFixture(
    provider === "byo-ai"
      ? "https://operator.example/custom/runtime"
      : "https://api.replicate.com/v1",
  );
  http.state.pollsBeforeSuccess = 0;
  closes.push(vault.close, http.close);
  const detach = bindAiConnectionTransport(http.port);
  closes.push(async () => detach());
  const hosted = bindHostedModelAuthority({
    fetch,
    assertCurrent: http.port.assertCurrent,
    read: selected,
    connections: () =>
      readDeviceRows().flatMap((row) => {
        const value = selected(row.connectionId);
        return value ? [value] : [];
      }),
    execute: async () => {
      throw new Error("Must use selected saved AI consumer.");
    },
  });
  closes.push(async () => hosted());
  const draft = {
    ...aiConnectionDraft(provider),
    family: "replicate_predictions" as const,
    baseUrl: http.baseUrl,
    model: "owner/model",
    apiKey: REPLICATE_TOKEN,
  };
  return { vault, http, draft };
}
const verificationInput = { prompt: "Transient verification only.", steps: 1 };
const operationInput = { prompt: "Actual cold selected prediction.", steps: 3 };
const input = {
  model: "owner/model",
  messages: [
    { role: "user" as const, content: JSON.stringify(operationInput) },
  ],
};
async function coldReload() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  await initializeVaultCredentialCustody();
}
it.each(["byo-ai", "replicate"])(
  "actually tests/saves/cold-reloads/consumes %s predictions through shared hosted inference and sealed Token custody",
  async (provider) => {
    const f = await setup(provider);
    await expect(
      testAiConnection(f.draft, undefined, verificationInput),
    ).resolves.toBe("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    const saved = await saveAiConnection(f.draft, undefined, verificationInput);
    const record = loadNativeConnectorRecord(saved.connectionId);
    expect(
      record?.privateState.credentials.ai_credential_reference,
    ).toBeTruthy();
    expect(record?.privateState.credentials).not.toHaveProperty("api_key");
    expect(readAiConnection(saved.connectionId)).toMatchObject({
      family: "replicate_predictions",
      apiKey: "",
    });
    expect(aiDelegationAvailable(saved.connectionId)).toBe(false);
    for (const secret of [REPLICATE_TOKEN, verificationInput.prompt]) {
      expect(JSON.stringify(readDeviceRows())).not.toContain(secret);
      expect([...f.vault.files.values()].join(" ")).not.toContain(secret);
    }
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === REPLICATE_TOKEN,
        ),
    ).toBe(true);
    await coldReload();
    await expect(
      performHostedInference(saved.connectionId, input, {
        fetch,
        signal: f.http.port.signal,
        assertCurrent: f.http.port.assertCurrent,
      }),
    ).resolves.toMatchObject({
      providerId: provider,
      answer: JSON.stringify(
        {
          text: "Independently produced prediction.",
          asset: "https://untrusted.example/generated.png",
        },
        null,
        2,
      ),
    });
    expect(f.http.requests.map((row) => row.method)).toEqual([
      "POST",
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
    ]);
    expect(JSON.parse(f.http.requests.at(-2)?.body ?? "")).toEqual({
      input: operationInput,
    });
    expect(
      f.http.requests.every(
        (row) => row.authorization === `Bearer ${REPLICATE_TOKEN}`,
      ),
    ).toBe(true);
  },
);
it("requires explicit bounded model-specific input on both test and save, never invents a generic prompt", async () => {
  const f = await setup();
  await expect(testAiConnection(f.draft)).rejects.toThrow(
    "explicit model-specific",
  );
  await expect(saveAiConnection(f.draft)).rejects.toThrow(
    "explicit model-specific",
  );
  await expect(
    saveAiConnection(f.draft, undefined, { prompt: "x".repeat(32769) }),
  ).rejects.toThrow("JSON object");
  expect(f.http.requests).toEqual([]);
  expect(readDeviceRows()).toEqual([]);
});
it("refuses retained token replay after a target/model/family/auth change before another create", async () => {
  const f = await setup();
  const saved = await saveAiConnection(f.draft, undefined, verificationInput);
  const current = readAiConnection(saved.connectionId);
  if (!current) throw new Error("Missing actual saved target");
  const count = f.http.requests.length;
  for (const change of [
    { baseUrl: "https://other.example/v1" },
    { model: "other/model" },
    { family: "openai_chat" as const },
    { authentication: "none" as const },
  ])
    await expect(
      saveAiConnection(
        { ...current, ...change },
        saved.connectionId,
        verificationInput,
      ),
    ).rejects.toThrow();
  expect(f.http.requests).toHaveLength(count);
});
it.each(["vault", "caller", "lease"])(
  "actual %s withdrawal closes a held saved prediction poll with no late output or authenticated cancellation",
  async (withdrawal) => {
    const f = await setup();
    const saved = await saveAiConnection(f.draft, undefined, verificationInput);
    const caller = new AbortController();
    f.http.state.mode = "held";
    const resultText = vi.fn();
    const count = f.http.requests.length;
    const result = expect(
      performSavedAiInference(
        saved.connectionId,
        input,
        {
          signal: caller.signal,
          assertCurrent: () => caller.signal.throwIfAborted(),
        },
        resultText,
      ),
    ).rejects.toThrow();
    await f.http.held;
    expect(f.http.requests).toHaveLength(count + 2);
    if (withdrawal === "vault") vaultStore.lock();
    else if (withdrawal === "lease") f.http.abort.abort();
    else caller.abort();
    await result;
    await vi.waitFor(() =>
      expect(f.http.requests.at(-1)).toMatchObject({
        closed: true,
        ended: false,
      }),
    );
    expect(resultText).not.toHaveBeenCalled();
    expect(f.http.requests).toHaveLength(count + 2);
  },
);
it.each(["unauthorized", "forbidden", "empty", "wrong-id"])(
  "failed %s Test/Save never publishes a verified record",
  async (mode) => {
    const f = await setup();
    f.http.state.mode = mode;
    const ambient = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No browser fallback"));
    await expect(
      testAiConnection(f.draft, undefined, verificationInput),
    ).rejects.toThrow();
    await expect(
      saveAiConnection(f.draft, undefined, verificationInput),
    ).rejects.toThrow();
    expect(readDeviceRows()).toEqual([]);
    expect(ambient).not.toHaveBeenCalled();
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === REPLICATE_TOKEN,
        ),
    ).toBe(false);
  },
);
it("fences a terminal response when its original caller ends before body settlement", async () => {
  const f = await setup();
  const saved = await saveAiConnection(f.draft, undefined, verificationInput);
  const caller = new AbortController();
  const output = vi.fn();
  f.http.state.onTerminal = () => caller.abort();
  await expect(
    performSavedAiInference(
      saved.connectionId,
      input,
      {
        signal: caller.signal,
        assertCurrent: () => caller.signal.throwIfAborted(),
      },
      output,
    ),
  ).rejects.toThrow();
  expect(output).not.toHaveBeenCalled();
  expect(f.http.requests.filter((row) => row.path.endsWith("/cancel"))).toEqual(
    [],
  );
});
