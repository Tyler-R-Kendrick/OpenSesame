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
import { aiConnectionProjection } from "./projection.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import {
  SCRIBE_TEXT,
  SCRIBE_TOKEN,
  ownedSpeechAudio,
  speechTlsFixture,
} from "./speech-tls.test-support.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";
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
async function setup(providerId = "elevenlabs") {
  const vault = await runtimeFixture();
  const http = await speechTlsFixture(
    providerId === "byo-ai"
      ? "https://operator.example/custom/runtime"
      : undefined,
  );
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport({
    ...http.port,
    assertEndpointAllowed(endpoint) {
      if (endpoint !== http.baseUrl)
        throw new Error("Unowned configured endpoint");
    },
  });
  closes.push(async () => release());
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
      throw new Error("Must use saved transcription consumer");
    },
  });
  closes.push(async () => hosted());
  const draft: AiConnectionDraft = {
    providerId,
    name: "Private saved Scribe",
    family: "elevenlabs_scribe",
    baseUrl: http.baseUrl,
    model: "scribe_v2",
    authentication: "api-key",
    apiKey: SCRIBE_TOKEN,
    tokenParameter: "max_tokens",
  };
  return { vault, http, draft };
}
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
it.each(["elevenlabs", "byo-ai"])(
  "tests/saves/cold-reloads and consumes %s transcription with sealed custody",
  async (providerId) => {
    const f = await setup(providerId);
    const audio = ownedSpeechAudio();
    await expect(
      testAiConnection(f.draft, undefined, undefined, { audio }),
    ).resolves.toBe("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    const saved = await saveAiConnection(f.draft, undefined, undefined, {
      audio,
    });
    const record = loadNativeConnectorRecord(saved.connectionId);
    expect(
      record?.privateState.credentials.ai_credential_reference,
    ).toBeTruthy();
    expect(readAiConnection(saved.connectionId)).toMatchObject({
      family: "elevenlabs_scribe",
      apiKey: "",
    });
    expect(aiDelegationAvailable(saved.connectionId)).toBe(false);
    expect(aiConnectionProjection(saved.connectionId)).toBe("verified");
    expect(JSON.stringify(readDeviceRows())).not.toContain(SCRIBE_TOKEN);
    expect([...f.vault.files.values()].join(" ")).not.toContain(SCRIBE_TOKEN);
    expect(JSON.stringify(record)).not.toContain("recording.audio");
    expect(
      vaultStore
        .getSnapshot()
        .items.some(
          (item) =>
            item.kind === "credential" &&
            item.method.type === "token" &&
            item.method.token === SCRIBE_TOKEN,
        ),
    ).toBe(true);
    await coldReload();
    await expect(
      performHostedInference(
        saved.connectionId,
        { model: "scribe_v2", messages: [], media: audio },
        {
          fetch,
          signal: f.http.port.signal,
          assertCurrent: f.http.port.assertCurrent,
        },
      ),
    ).resolves.toEqual({ providerId, model: "scribe_v2", answer: SCRIBE_TEXT });
    expect(f.http.records).toHaveLength(3);
    expect(
      f.http.records.every(
        (row) =>
          row.authenticated &&
          row.method === "POST" &&
          row.key === SCRIBE_TOKEN,
      ),
    ).toBe(true);
    expect(f.http.records.at(-1)?.audio).toEqual(Buffer.from(audio.bytes));
    expect(aiConnectionProjection(saved.connectionId)).toBe("verified");
  },
);
it("requires explicit local audio for Test/Save without inventing a prompt", async () => {
  const f = await setup();
  await expect(testAiConnection(f.draft)).rejects.toThrow(
    "explicit local audio",
  );
  await expect(saveAiConnection(f.draft)).rejects.toThrow(
    "explicit local audio",
  );
  await expect(
    saveAiConnection(
      f.draft,
      undefined,
      { prompt: "not speech input" },
      { audio: ownedSpeechAudio() },
    ),
  ).rejects.toThrow("explicit local audio");
  expect(f.http.records).toEqual([]);
  expect(readDeviceRows()).toEqual([]);
});
it("retains the same sealed key only for the exact saved target and model", async () => {
  const f = await setup();
  const options = { audio: ownedSpeechAudio() };
  const saved = await saveAiConnection(f.draft, undefined, undefined, options);
  const draft = readAiConnection(saved.connectionId);
  if (!draft) throw new Error("Missing saved speech target");
  const updated = await saveAiConnection(
    draft,
    saved.connectionId,
    undefined,
    options,
  );
  expect(updated.connectionId).toBe(saved.connectionId);
  const count = f.http.records.length;
  for (const change of [
    { baseUrl: "https://other.example/v1" },
    { model: "scribe_v1" },
    { family: "openai_chat" as const },
    { authentication: "none" as const },
  ])
    await expect(
      saveAiConnection(
        { ...draft, ...change },
        saved.connectionId,
        undefined,
        options,
      ),
    ).rejects.toThrow();
  expect(f.http.records).toHaveLength(count);
});
it.each([
  "unauthorized",
  "forbidden",
  "empty",
  "echo",
  "malformed",
  "wrong-mime",
])(
  "failed %s Test/Save never creates a verified row or credential",
  async (mode) => {
    const f = await setup();
    f.http.state.mode = mode;
    const ambient = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No browser fallback"));
    await expect(
      testAiConnection(f.draft, undefined, undefined, {
        audio: ownedSpeechAudio(),
      }),
    ).rejects.toThrow();
    await expect(
      saveAiConnection(f.draft, undefined, undefined, {
        audio: ownedSpeechAudio(),
      }),
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
            item.method.token === SCRIBE_TOKEN,
        ),
    ).toBe(false);
  },
);
it("does not borrow audio or transcription callbacks for a text family", async () => {
  const f = await setup();
  const saved = await saveAiConnection(f.draft, undefined, undefined, {
    audio: ownedSpeechAudio(),
  });
  const text = vi.fn();
  const count = f.http.records.length;
  await expect(
    performSavedAiInference(
      saved.connectionId,
      { model: "scribe_v2", messages: [], media: ownedSpeechAudio() },
      undefined,
      text,
    ),
  ).rejects.toThrow("finite transcript");
  expect(text).not.toHaveBeenCalled();
  expect(f.http.records).toHaveLength(count);
});

it.each(["guest", "wrong vault", "second step"])(
  "does not project a saved speech proof into %s ownership",
  async (state) => {
    const f = await setup();
    const saved = await saveAiConnection(f.draft, undefined, undefined, {
      audio: ownedSpeechAudio(),
    });
    const snapshot = vaultStore.getSnapshot();
    vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
      ...snapshot,
      guest: state === "guest",
      tomb: state === "wrong vault" ? "other-vault" : snapshot.tomb,
      awaitingSecondStep: state === "second step",
    });
    expect(aiConnectionProjection(saved.connectionId)).toBe("pending");
    const count = f.http.records.length;
    await expect(
      performSavedAiInference(saved.connectionId, {
        model: "scribe_v2",
        messages: [],
        media: ownedSpeechAudio(),
      }),
    ).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
  },
);
