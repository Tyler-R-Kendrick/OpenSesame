/** @vitest-environment jsdom */
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import {
  ASSEMBLY_KEY,
  ASSEMBLY_TEXT,
  assemblyTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/assemblyai-tls.test-support.js";
import { validateAiConnection } from "@opensesame/app-core/lib/ai-connections/configuration.js";
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
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import * as ui from "./scribe-ui.test-support.js";

const closes: (() => Promise<void>)[] = [];
type Http = Awaited<ReturnType<typeof assemblyTlsFixture>>;
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function route(baseUrl: string, model: string) {
  const http = await assemblyTlsFixture({ baseUrl, model });
  closes.push(http.close);
  const release = bindAiConnectionTransport(http.port);
  closes.push(async () => release());
  return http;
}
async function setup(
  providerId = "assemblyai",
  model = "universal-3-5-pro",
  baseUrl = "https://api.assemblyai.com/v2",
) {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  closes.push(vault.close);
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) =>
    timer(fn, ms === 3000 ? 1 : ms, ...args),
  );
  const http = await route(baseUrl, model);
  const user = userEvent.setup();
  const mounted = ui.draw(providerId);
  if (providerId === "byo-ai")
    await user.selectOptions(
      screen.getByLabelText("API family"),
      "assemblyai_transcript",
    );
  if (providerId === "assemblyai")
    expect(screen.getByLabelText("Model ID")).toHaveProperty(
      "value",
      "universal-3-5-pro",
    );
  ui.field("API base URL", baseUrl);
  ui.field("Model ID", model);
  ui.field("API key", ASSEMBLY_KEY);
  return {
    providerId,
    model,
    baseUrl,
    vault,
    http,
    user,
    mounted,
    routes: [http],
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
/** A1 oracle owns one job. New same-target routes bind only between completed workflows. */
async function next(f: Fixture) {
  f.http = await route(f.baseUrl, f.model);
  f.routes.push(f.http);
}
async function sample(f: Fixture, label = "Verification audio") {
  await f.user.upload(screen.getByLabelText(label), ui.audioFile());
  await waitFor(() =>
    expect(
      ui.button(
        label === "Verification audio"
          ? "Test AI connection"
          : "Transcribe audio",
      ),
    ).toHaveProperty("disabled", false),
  );
}
async function save(f: Fixture) {
  await sample(f);
  await f.user.click(ui.button("Save AI connection"));
  await screen.findByLabelText(
    "AI connection verified and saved in this vault",
  );
  return ui.savedId();
}
async function closed(http: Http) {
  await waitFor(() =>
    expect(http.records.find((r) => r.phase === "poll")).toMatchObject({
      closed: true,
      ended: false,
    }),
  );
}

it.each([
  ["assemblyai", "universal-3-5-pro", "https://api.assemblyai.com/v2"],
  ["assemblyai", "universal-2", "https://api.eu.assemblyai.com/v2"],
  ["byo-ai", "operator-speech.v2", "https://operator.example/custom/speech"],
])(
  "%s/%s actual Test/Save/sealed cold workspace consumes completed TLS transcripts and deletes each owned job",
  async (provider, model, base) => {
    const f = await setup(provider, model, base);
    expect(screen.getAllByRole("form")).toHaveLength(1);
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(screen.getByRole("form").textContent).toContain(
      "processing or charges stopped",
    );
    const ambient = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No ambient fallback"));
    await sample(f);
    await f.user.click(ui.button("Test AI connection"));
    await screen.findByLabelText("Model inference verified");
    expect(readDeviceRows()).toEqual([]);
    await next(f);
    const id = await save(f);
    expect(ui.storedDraft(id)).toMatchObject({
      family: "assemblyai_transcript",
      baseUrl: base,
      model,
      apiKey: "",
    });
    expect(screen.getByLabelText("API key", { exact: true })).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByLabelText("Verification audio")).toHaveProperty(
      "value",
      "",
    );
    expect(aiDelegationAvailable(id)).toBe(false);
    expect(JSON.stringify(readDeviceRows())).not.toContain(ASSEMBLY_KEY);
    expect([...f.vault.files.values()].join(" ")).not.toContain(ASSEMBLY_KEY);
    cleanup();
    await act(ui.cold);
    await next(f);
    ui.draw(provider, id);
    expect(ui.storedDraft(id)).toMatchObject({
      baseUrl: base,
      model,
      apiKey: "",
    });
    expect(screen.queryByLabelText("Stream response")).toBeNull();
    await sample(f, "Audio to transcribe");
    await f.user.click(ui.button("Transcribe audio"));
    await waitFor(() =>
      expect(screen.getByLabelText("Transcript").textContent).toBe(
        ASSEMBLY_TEXT,
      ),
    );
    await waitFor(() =>
      expect(ui.button("Transcribe audio")).toHaveProperty("disabled", false),
    );
    for (const http of f.routes) {
      expect(http.records.map((r) => r.phase)).toEqual([
        "upload",
        "create",
        "poll",
        "poll",
        "delete",
      ]);
      expect(
        http.records.every(
          (r) => r.authenticated && r.authorization === ASSEMBLY_KEY,
        ),
      ).toBe(true);
      expect(JSON.parse(http.records[1].body.toString())).toEqual({
        audio_url: http.upload,
        speech_models: [model],
        language_code: "en",
      });
      expect(http.records.at(-1)?.path).toBe(
        `${new URL(base).pathname}/transcript/${http.id}`,
      );
    }
    expect(ambient).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /untrusted/ })).toBeNull();
  },
);
it.each(["Test AI connection", "Save AI connection", "Transcribe audio"])(
  "shared %s Cancel forwards user signal and deletes only the captured job without success or transcript",
  async (label) => {
    const f = await setup();
    let id: string | undefined;
    if (label === "Transcribe audio") {
      id = await save(f);
      await next(f);
    }
    f.http.state.hold = "poll";
    await sample(f, id ? "Audio to transcribe" : "Verification audio");
    await f.user.click(ui.button(label));
    await f.http.held;
    await f.user.click(ui.button("Cancel transcription"));
    await screen.findByLabelText(
      "Stopped waiting; transcript deletion was acknowledged. Provider processing or charges may continue.",
    );
    await closed(f.http);
    expect(f.http.records.map((r) => r.phase)).toEqual([
      "upload",
      "create",
      "poll",
      "delete",
    ]);
    expect(screen.queryByLabelText("Model inference verified")).toBeNull();
    expect(
      screen.queryAllByLabelText(
        "AI connection verified and saved in this vault",
      ),
    ).toHaveLength(id ? 1 : 0);
    expect(screen.queryByLabelText("Transcript")?.textContent ?? "").toBe("");
    expect(readDeviceRows()).toHaveLength(id ? 1 : 0);
  },
);
it.each(["unauthorized", "malformed", "echo", "delete-failed"])(
  "%s real Save failure never accepts a transcript or sealed record",
  async (mode) => {
    const f = await setup();
    f.http.state.phase =
      mode === "unauthorized"
        ? "upload"
        : mode === "delete-failed"
          ? "delete"
          : "poll";
    f.http.state.mode = mode === "delete-failed" ? "forbidden" : mode;
    await sample(f);
    await f.user.click(ui.button("Save AI connection"));
    await screen.findByLabelText(
      /refused the credential|invalid or unsafe|unreadable JSON|removal was not confirmed/,
    );
    expect(readDeviceRows()).toEqual([]);
    expect(
      screen.queryByLabelText("AI connection verified and saved in this vault"),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(ASSEMBLY_KEY);
    if (mode !== "unauthorized")
      expect(f.http.records.at(-1)?.phase).toBe("delete");
  },
);
it.each(["caller", "lock", "route", "credential", "forget"])(
  "saved %s withdrawal suppresses held output and forbids new authenticated cleanup",
  async (end) => {
    const f = await setup();
    const id = await save(f);
    cleanup();
    await next(f);
    const caller = new AbortController();
    f.http.state.hold = "poll";
    const input = { model: f.model, messages: [], media: ownedSpeechAudio() };
    const runtime = {
      signal: caller.signal,
      assertCurrent: () => caller.signal.throwIfAborted(),
    };
    const rejected = expect(
      performSavedAiInference(id, input, runtime),
    ).rejects.toThrow();
    await f.http.held;
    if (end === "caller") caller.abort();
    else if (end === "lock") vaultStore.lock();
    else if (end === "route") f.http.abort.abort();
    else if (end === "forget") await deleteAiConnection(id);
    else {
      const item = vaultStore
        .getSnapshot()
        .items.find((row) => row.kind === "credential");
      if (!item || item.kind !== "credential" || item.method.type !== "token")
        throw new Error("Expected sealed token");
      await vaultStore.saveItem({
        ...item,
        method: {
          ...item.method,
          token: "legitimate-replacement-assembly-key",
        },
      });
    }
    if (["caller", "lock", "route"].includes(end)) await closed(f.http);
    else f.http.release();
    await rejected;
    expect(f.http.records.map((r) => r.phase)).toEqual([
      "upload",
      "create",
      "poll",
    ]);
    const count = f.http.records.length;
    await expect(performSavedAiInference(id, input, runtime)).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
  },
);
it.each(["API base URL", "Model ID"])(
  "saved %s edit clears audio and requires a new credential",
  async (label) => {
    const f = await setup();
    await save(f);
    await sample(f);
    ui.field(
      label,
      label === "Model ID" ? "universal-2" : "https://other.example/speech",
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
  },
);
it("admits only the configured closed native/BYO speech family and refuses generic request/answer/stream or text input before HTTP", async () => {
  const draft = { ...aiConnectionDraft("assemblyai"), apiKey: ASSEMBLY_KEY };
  expect(validateAiConnection(draft)).toEqual(draft);
  expect(aiConnectionFamilies("assemblyai").map((r) => r.id)).toEqual([
    "assemblyai_transcript",
  ]);
  expect(aiConnectionFamilies("byo-ai").map((r) => r.id)).toContain(
    "assemblyai_transcript",
  );
  for (const change of [
    { providerId: "openai" },
    { family: "openai_chat" },
    { model: "invalid/model" },
    { authentication: "none" },
    { model: ASSEMBLY_KEY },
    { apiKey: "key\r\nheader" },
    { azure: { api: "v1", credential: "api-key" } },
    { vertex: aiConnectionDraft("google-vertex").vertex },
    { bedrock: { region: "us-east-1", credential: "sigv4" } },
  ])
    expect(() => validateAiConnection({ ...draft, ...change })).toThrow();
  const input = { model: draft.model, messages: [], media: ownedSpeechAudio() };
  expect(() => aiConnectionHeaders(draft)).toThrow("job adapter");
  expect(() => aiInferenceRequest(draft, input)).toThrow("finite");
  expect(() => aiInferenceAnswer(draft.family, {})).toThrow("finite");
  const fetch = vi.fn(async () => {
    throw new Error("Must not dispatch");
  });
  const check = () => {};
  const transport = {
    fetch,
    signal: new AbortController().signal,
    assertCurrent: check,
  };
  for (const invalid of [
    { ...input, model: "unrequested" },
    { ...input, maxOutputTokens: 16 },
    { ...input, messages: [{ role: "user" as const, content: "prompt" }] },
    { model: draft.model, messages: [] },
  ])
    await expect(
      inferAiConnection(draft, invalid, transport, check),
    ).rejects.toThrow();
  await expect(
    inferAiConnection(draft, input, transport, check, check),
  ).rejects.toThrow("finite");
  expect(() => probeAiConnection(draft, transport, check)).toThrow(
    "local audio",
  );
  expect(fetch).not.toHaveBeenCalled();
});
