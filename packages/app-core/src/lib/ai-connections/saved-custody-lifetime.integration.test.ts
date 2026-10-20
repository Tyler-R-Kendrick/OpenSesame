import { afterEach, expect, it, vi } from "vitest";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { itemText } from "../vault/item-departure.js";
import { vaultStore } from "../vault/store.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
} from "./runtime.js";
import {
  SCRIBE_TEXT,
  SCRIBE_TOKEN,
  ownedSpeechAudio,
  speechTlsFixture,
} from "./speech-tls.test-support.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup() {
  const vault = await runtimeFixture();
  const http = await speechTlsFixture();
  closes.push(vault.close, http.close);
  const capture = vi.fn(() => http.port);
  const release = bindAiConnectionTransport({ ...http.port, capture });
  closes.push(async () => release());
  const ambient = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("No ambient fetch authority");
  });
  const draft: AiConnectionDraft = {
    providerId: "elevenlabs",
    name: "Owned saved custody",
    family: "elevenlabs_scribe",
    baseUrl: http.baseUrl,
    model: "scribe_v2",
    authentication: "api-key",
    apiKey: SCRIBE_TOKEN,
    tokenParameter: "max_tokens",
  };
  const view = await saveAiConnection(draft, undefined, undefined, {
    audio: ownedSpeechAudio(),
  });
  const input = { model: draft.model, messages: [], media: ownedSpeechAudio() };
  const token = vaultStore
    .getSnapshot()
    .items.find((item) => item.kind === "credential");
  if (!token || token.kind !== "credential" || token.method.type !== "token")
    throw new Error("Expected actual saved token");
  expect(token.method.token).toBe(SCRIBE_TOKEN);
  return { vault, http, input, view, token, capture, ambient };
}
it("unchanged saved Scribe custody consumes a held actual TLS transcript with one original route and no ambient fetch", async () => {
  const f = await setup();
  const count = f.capture.mock.calls.length;
  f.http.state.mode = "held";
  const result = performSavedAiInference(f.view.connectionId, f.input);
  await f.http.held;
  expect(f.capture).toHaveBeenCalledTimes(count + 1);
  f.http.release();
  await expect(result).resolves.toMatchObject({ answer: SCRIBE_TEXT });
  f.http.state.mode = "complete";
  await expect(
    performSavedAiInference(f.view.connectionId, f.input),
  ).resolves.toMatchObject({ answer: SCRIBE_TEXT });
  expect(f.http.records).toHaveLength(3);
  expect(f.ambient).not.toHaveBeenCalled();
});
it.each(["edit", "trash", "delete", "withdraw", "forget"])(
  "actual saved Scribe token %s during a held response prevents the old transcript and all later authentication",
  async (change) => {
    const f = await setup();
    const count = f.capture.mock.calls.length;
    f.http.state.mode = "held";
    const result = expect(
      performSavedAiInference(f.view.connectionId, f.input),
    ).rejects.toThrow();
    await f.http.held;
    expect(f.capture).toHaveBeenCalledTimes(count + 1);
    if (change === "edit") {
      if (f.token.method.type !== "token")
        throw new Error("Expected valid Token method");
      await vaultStore.saveItem({
        ...f.token,
        method: { ...f.token.method, token: "edited-unverified-token" },
      });
    } else if (change === "trash") await vaultStore.trashItem(f.token.id);
    else if (change === "delete") {
      await vaultStore.trashItem(f.token.id);
      await vaultStore.purgeItem(f.token.id);
    } else if (change === "withdraw")
      await vaultStore.withdrawItems({
        items: { [f.token.id]: itemText(f.token) },
        folderIds: [],
      });
    else await deleteAiConnection(f.view.connectionId);
    f.http.release();
    await result;
    const dispatched = f.http.records.length;
    await expect(
      performSavedAiInference(f.view.connectionId, f.input),
    ).rejects.toThrow();
    expect(f.http.records).toHaveLength(dispatched);
    expect(f.ambient).not.toHaveBeenCalled();
  },
);
