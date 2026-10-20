/** @vitest-environment jsdom */
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { validateAiConnection } from "@opensesame/app-core/lib/ai-connections/configuration.js";
import {
  DEEPGRAM_TEXT,
  DEEPGRAM_TOKEN,
  deepgramTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/deepgram-tls.test-support.js";
import { aiDelegationAvailable } from "@opensesame/app-core/lib/ai-connections/delegation.js";
import {
  inferAiConnection,
  probeAiConnection,
} from "@opensesame/app-core/lib/ai-connections/inference.js";
import {
  aiConnectionDraft,
  aiConnectionFamilies,
} from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  aiConnectionHeaders,
  aiInferenceAnswer,
  aiInferenceRequest,
} from "@opensesame/app-core/lib/ai-connections/protocol.js";
import {
  deleteAiConnection,
  performSavedAiInference,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { ownedSpeechAudio } from "@opensesame/app-core/lib/ai-connections/speech-tls.test-support.js";
import { AI_CONNECTION_CLASSIFICATION } from "@opensesame/app-core/lib/ai-connections/store.js";
import { readAiTextStream } from "@opensesame/app-core/lib/ai-connections/stream.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeOAuthGuard } from "@opensesame/app-core/lib/native-oauth-session.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as ui from "./scribe-ui.test-support.js";

const current = () => {};
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function setup(providerId = "deepgram", model = "nova-3") {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  const http = await deepgramTlsFixture(
    providerId === "byo-ai"
      ? "https://operator.example/custom/runtime"
      : "https://api.deepgram.com/v1",
    model,
  );
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  const user = userEvent.setup();
  const mounted = ui.draw(providerId);
  const family = screen.getByLabelText("API family");
  if (providerId === "byo-ai")
    await user.selectOptions(family, "deepgram_listen");
  if (providerId === "deepgram")
    expect(screen.getByLabelText("Model ID")).toHaveProperty("value", "nova-3");
  ui.field("API base URL", http.baseUrl);
  ui.field("Model ID", model);
  ui.field("API key", DEEPGRAM_TOKEN);
  return { vault, http, user, mounted, providerId, model };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function sample(f: Fixture, label = "Verification audio") {
  await f.user.upload(screen.getByLabelText(label), ui.audioFile());
  const action =
    label === "Verification audio" ? "Test AI connection" : "Transcribe audio";
  await waitFor(() =>
    expect(ui.button(action)).toHaveProperty("disabled", false),
  );
}
async function save(f: Fixture) {
  await sample(f);
  await f.user.click(ui.button("Save AI connection"));
  await screen.findByRole("region", { name: "Model inference" });
  return ui.savedId();
}
async function closed(f: Fixture) {
  await waitFor(() =>
    expect(f.http.records.at(-1)).toMatchObject({ closed: true, ended: false }),
  );
}
it.each([
  ["deepgram", "nova-3"],
  ["deepgram", "nova-2"],
  ["byo-ai", "custom_model.v2-tenant"],
])(
  "%s/%s full Settings Test/Save/cold workspace consumes actual raw-audio TLS transcripts with sealed custody",
  async (provider, model) => {
    const f = await setup(provider, model);
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(screen.getByLabelText("API family")).toHaveProperty(
      "value",
      "deepgram_listen",
    );
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(
      screen.queryByLabelText("Authentication", { exact: true }),
    ).toBeNull();
    expect(ui.button("Test AI connection")).toHaveProperty("disabled", true);
    await sample(f);
    await f.user.click(ui.button("Test AI connection"));
    await screen.findByLabelText("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    const id = await save(f);
    expect(ui.storedDraft(id)).toMatchObject({
      family: "deepgram_listen",
      baseUrl: f.http.baseUrl,
      model,
      apiKey: "",
    });
    expect(aiDelegationAvailable(id)).toBe(false);
    expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByLabelText("Verification audio")).toHaveProperty(
      "value",
      "",
    );
    expect(JSON.stringify(readDeviceRows())).not.toContain(DEEPGRAM_TOKEN);
    expect([...f.vault.files.values()].join(" ")).not.toContain(DEEPGRAM_TOKEN);
    expect(JSON.stringify(readDeviceRows())).not.toContain("owned.wav");
    cleanup();
    await act(ui.cold);
    ui.draw(provider, id);
    expect(screen.getByLabelText("API base URL")).toHaveProperty(
      "value",
      f.http.baseUrl,
    );
    expect(screen.getByLabelText("Model ID")).toHaveProperty("value", model);
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    await sample(f, "Audio to transcribe");
    await f.user.click(ui.button("Transcribe audio"));
    await waitFor(() =>
      expect(screen.getByLabelText("Transcript").textContent).toBe(
        DEEPGRAM_TEXT,
      ),
    );
    expect(f.http.records).toHaveLength(3);
    for (const row of f.http.records) {
      expect(row.authenticated).toBe(true);
      expect(row.body).toEqual(Buffer.from(ownedSpeechAudio().bytes));
    }
    expect(screen.queryByRole("link", { name: /untrusted/ })).toBeNull();
  },
);
it.each(["unauthorized", "forbidden", "malformed", "echo", "accepted"])(
  "failed %s actual transcription never saves or exposes credential material",
  async (mode) => {
    const f = await setup();
    f.http.state.mode = mode;
    await sample(f);
    await f.user.click(ui.button("Save AI connection"));
    await screen.findByLabelText(
      mode === "unauthorized" || mode === "forbidden"
        ? "The AI service refused the credential or its permissions."
        : mode === "malformed"
          ? "The AI service returned an unreadable JSON response."
          : "The transcription service returned an invalid or unsafe transcript.",
    );
    expect(readDeviceRows()).toEqual([]);
    expect(
      screen.queryByRole("region", { name: "Model inference" }),
    ).toBeNull();
    expect(screen.getByRole("form").textContent).not.toContain(DEEPGRAM_TOKEN);
    expect(f.http.records).toHaveLength(1);
  },
);
it.each(["empty", "oversized", "magic", "MIME"])(
  "rejects %s local audio before credential HTTP",
  async (kind) => {
    const f = await setup();
    const bytes = new Uint8Array(
      kind === "empty" ? 0 : kind === "oversized" ? 1048577 : 44,
    );
    const file = ui.audioFile(
      "rejected.wav",
      bytes,
      kind === "MIME" ? "text/plain" : "audio/wav",
    );
    fireEvent.change(screen.getByLabelText("Verification audio"), {
      target: { files: [file] },
    });
    await screen.findByLabelText(
      "Choose a recognized local audio file within the 1 MiB recording/upload bound.",
    );
    expect(ui.button("Test AI connection")).toHaveProperty("disabled", true);
    expect(ui.button("Save AI connection")).toHaveProperty("disabled", true);
    expect(f.http.records).toEqual([]);
  },
);
it.each(["cancel", "unmount", "lock", "provider", "route"])(
  "actual %s physically ends held owned Save without storing credentials or late success",
  async (end) => {
    const f = await setup();
    f.http.state.mode = "held";
    await sample(f);
    await f.user.click(ui.button("Save AI connection"));
    await f.http.held;
    if (end === "cancel") await f.user.click(ui.button("Cancel transcription"));
    else if (end === "unmount") f.mounted.unmount();
    else if (end === "lock") act(() => vaultStore.lock());
    else if (end === "provider")
      await act(async () => f.mounted.navigate("byo-ai"));
    else await act(async () => f.http.abort.abort());
    await closed(f);
    f.http.release();
    expect(readDeviceRows()).toEqual([]);
    expect(
      screen.queryByRole("region", { name: "Model inference" }),
    ).toBeNull();
    if (end === "cancel" || end === "lock")
      expect(screen.getByLabelText("Verification audio")).toHaveProperty(
        "value",
        "",
      );
  },
);
it("saved workspace Cancel physically closes only its operation and preserves the saved connection", async () => {
  const f = await setup();
  const id = await save(f);
  f.http.state.mode = "held";
  await sample(f, "Audio to transcribe");
  await f.user.click(ui.button("Transcribe audio"));
  await f.http.held;
  await f.user.click(ui.button("Cancel transcription"));
  await closed(f);
  expect(ui.storedDraft(id)).toMatchObject({
    family: "deepgram_listen",
    apiKey: "",
  });
  expect(screen.getByLabelText("Transcript").textContent).toBe("");
  expect(screen.getByLabelText("Audio to transcribe")).toHaveProperty(
    "value",
    "",
  );
});
it.each(["caller", "lock", "route", "revision", "credential", "forget"])(
  "%s withdrawal prevents a held saved transcript and subsequent stale authentication",
  async (end) => {
    const f = await setup();
    const id = await save(f);
    cleanup();
    const controller = new AbortController();
    const caller = {
      signal: controller.signal,
      assertCurrent() {
        expect(this).toBe(caller);
        controller.signal.throwIfAborted();
      },
    };
    const input = { model: f.model, messages: [], media: ownedSpeechAudio() };
    f.http.state.mode = "held";
    const result = expect(
      performSavedAiInference(id, input, caller),
    ).rejects.toThrow();
    await f.http.held;
    if (end === "caller") controller.abort();
    else if (end === "lock") vaultStore.lock();
    else if (end === "route") f.http.abort.abort();
    else if (end === "forget") await deleteAiConnection(id);
    else if (end === "revision") {
      const record = loadNativeConnectorRecord(id);
      if (!record) throw new Error("Expected committed Deepgram row");
      await updateNativeConnector(
        id,
        nativeOAuthGuard(record),
        AI_CONNECTION_CLASSIFICATION,
        (current) => ({
          ...current,
          runtime: { ...current.runtime, verifiedAt: null },
        }),
      );
    } else {
      const item = vaultStore
        .getSnapshot()
        .items.find((row) => row.kind === "credential");
      if (!item || item.kind !== "credential" || item.method.type !== "token")
        throw new Error("Expected actual sealed token");
      await vaultStore.saveItem({
        ...item,
        method: { ...item.method, token: "replacement-deepgram-key" },
      });
    }
    if (["caller", "lock", "route"].includes(end)) await closed(f);
    else f.http.release();
    await result;
    const count = f.http.records.length;
    await expect(performSavedAiInference(id, input, caller)).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
  },
);
it.each(["API base URL", "Model ID"])(
  "saved %s edit clears local audio and requires fresh credential entry",
  async (label) => {
    const f = await setup();
    await save(f);
    await sample(f);
    ui.field(
      label,
      label === "Model ID" ? "nova-2" : "https://other.example/v1",
    );
    expect(screen.getByLabelText("Verification audio")).toHaveProperty(
      "value",
      "",
    );
    await f.user.upload(
      screen.getByLabelText("Verification audio"),
      ui.audioFile(),
    );
    await screen.findByLabelText("Selected audio");
    expect(ui.button("Test AI connection")).toHaveProperty("disabled", true);
    expect(f.http.records).toHaveLength(1);
  },
);
it("shared admission preserves the Deepgram preset, BYO family, strict target and generic protocol refusals", async () => {
  const draft = { ...aiConnectionDraft("deepgram"), apiKey: DEEPGRAM_TOKEN };
  expect(validateAiConnection(draft)).toEqual(draft);
  expect(aiConnectionFamilies("deepgram").map((row) => row.id)).toEqual([
    "deepgram_listen",
  ]);
  expect(aiConnectionFamilies("byo-ai").map((row) => row.id)).toContain(
    "deepgram_listen",
  );
  for (const change of [
    { providerId: "openai" },
    { family: "openai_chat" },
    { model: "owner/model" },
    { authentication: "none" },
    { apiKey: "private\r\nheader" },
    { model: DEEPGRAM_TOKEN },
    { azure: { api: "v1", credential: "api-key" } },
    { vertex: aiConnectionDraft("google-vertex").vertex },
    { bedrock: { region: "us-east-1", credential: "sigv4" } },
  ])
    expect(() => validateAiConnection({ ...draft, ...change })).toThrow();
  const input = { model: draft.model, messages: [], media: ownedSpeechAudio() };
  expect(() => aiConnectionHeaders(draft)).toThrow("raw-audio");
  expect(() => aiInferenceRequest(draft, input)).toThrow("finite");
  expect(() => aiInferenceAnswer(draft.family, {})).toThrow("finite");
  const response = new Response("data: [DONE]\n\n");
  await expect(
    readAiTextStream(
      response,
      draft.family,
      current,
      current,
      new AbortController().signal,
    ),
  ).rejects.toThrow("finite");
  await response.body?.cancel();
  const fetch = vi.fn(async () => {
    throw new Error("Must not dispatch");
  });
  const transport = {
    fetch,
    signal: new AbortController().signal,
    assertCurrent: current,
  };
  for (const invalid of [
    { ...input, model: "nova-2" },
    { ...input, maxOutputTokens: 16 },
    { ...input, messages: [{ role: "user" as const, content: "prompt" }] },
    { model: draft.model, messages: [] },
  ])
    await expect(
      inferAiConnection(draft, invalid, transport, current),
    ).rejects.toThrow();
  await expect(
    inferAiConnection(draft, input, transport, current, current),
  ).rejects.toThrow("finite");
  expect(() => probeAiConnection(draft, transport, current)).toThrow(
    "local audio",
  );
  expect(fetch).not.toHaveBeenCalled();
});
