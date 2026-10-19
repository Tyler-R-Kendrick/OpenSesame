import { afterEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import {
  deleteAiConnection,
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
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";
import { aiVaultSeams } from "./vault-guard.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(saved = false) {
  const vault = await runtimeFixture();
  const http = await speechTlsFixture();
  closes.push(vault.close, http.close);
  const capture = vi.fn(() => http.port);
  const release = bindAiConnectionTransport({ ...http.port, capture });
  closes.push(async () => release());
  const draft: AiConnectionDraft = {
    providerId: "elevenlabs",
    name: "Owned Scribe",
    family: "elevenlabs_scribe",
    baseUrl: http.baseUrl,
    model: "scribe_v2",
    authentication: "api-key",
    apiKey: SCRIBE_TOKEN,
    tokenParameter: "max_tokens",
  };
  const audio = ownedSpeechAudio();
  const options = { audio, signal: new AbortController().signal };
  const view = saved
    ? await saveAiConnection(draft, undefined, undefined, options)
    : undefined;
  const caller = new AbortController();
  const runtime = {
    signal: caller.signal,
    checks: 0,
    assertCurrent() {
      expect(this).toBe(runtime);
      this.checks++;
      this.signal.throwIfAborted();
    },
  };
  return { vault, http, capture, draft, audio, options, view, caller, runtime };
}
function start(f: Awaited<ReturnType<typeof setup>>, operation: string) {
  if (operation === "saved") {
    if (!f.view) throw new Error("Expected saved Scribe");
    return performSavedAiInference(
      f.view.connectionId,
      { model: "scribe_v2", messages: [], media: f.audio },
      f.runtime,
    );
  }
  return operation === "save"
    ? saveAiConnection(f.draft, undefined, undefined, f.options)
    : testAiConnection(f.draft, undefined, undefined, f.options);
}
function holdVaultCapture() {
  const original = aiVaultSeams.capture;
  let entered = () => {};
  let release = () => {};
  const captured = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(aiVaultSeams, "capture").mockImplementationOnce(async () => {
    const held = await original();
    entered();
    await resumed;
    return held;
  });
  return { captured, release };
}
it.each(["test", "save", "saved"])(
  "captures one original %s route and immutable audio before vault hydration",
  async (operation) => {
    const f = await setup(operation === "saved");
    const count = f.capture.mock.calls.length;
    const expected = Buffer.from(f.audio.bytes);
    const gate = holdVaultCapture();
    const pending = start(f, operation);
    await gate.captured;
    expect(f.capture).toHaveBeenCalledTimes(count + 1);
    f.audio.bytes.fill(0);
    f.options.audio = { mimeType: "text/plain", bytes: new Uint8Array() };
    gate.release();
    await pending;
    expect(f.capture).toHaveBeenCalledTimes(count + 1);
    expect(f.http.records.at(-1)?.audio).toEqual(expected);
    expect(f.runtime.checks).toBeGreaterThanOrEqual(
      operation === "saved" ? 1 : 0,
    );
  },
);
it.each(["test", "save", "saved"])(
  "does not borrow a replacement native carrier after %s vault capture yields",
  async (operation) => {
    const f = await setup(operation === "saved");
    const before = f.http.records.length;
    const gate = holdVaultCapture();
    const pending = expect(start(f, operation)).rejects.toThrow("changed");
    await gate.captured;
    const fetch = vi.fn(async () => new Response("unowned replacement"));
    const release = bindAiConnectionTransport({ ...f.http.port, fetch });
    closes.push(async () => release());
    gate.release();
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    expect(f.http.records).toHaveLength(before);
  },
);
it.each(["signal", "method"])(
  "retains original saved caller %s identity across real vault acquisition",
  async (mutation) => {
    const f = await setup(true);
    const before = f.http.records.length;
    const gate = holdVaultCapture();
    const pending = expect(start(f, "saved")).rejects.toThrow("caller changed");
    await gate.captured;
    if (mutation === "signal") f.runtime.signal = new AbortController().signal;
    else f.runtime.assertCurrent = () => {};
    gate.release();
    await pending;
    expect(f.http.records).toHaveLength(before);
  },
);
it.each(["test", "save", "saved"])(
  "physical %s TLS socket closes when original caller ends",
  async (operation) => {
    const f = await setup(operation === "saved");
    f.http.state.mode = "held";
    const controller = new AbortController();
    f.options.signal = controller.signal;
    const pending = expect(start(f, operation)).rejects.toThrow();
    await f.http.held;
    if (operation === "saved") f.caller.abort();
    else controller.abort();
    await pending;
    await vi.waitFor(() =>
      expect(f.http.records.at(-1)).toMatchObject({
        closed: true,
        ended: false,
      }),
    );
    expect(readDeviceRows()).toHaveLength(operation === "saved" ? 1 : 0);
  },
);
it.each(["vault", "lease"])(
  "actual %s withdrawal closes a held saved transcription and prevents later HTTP",
  async (withdrawal) => {
    const f = await setup(true);
    f.http.state.mode = "held";
    const pending = expect(start(f, "saved")).rejects.toThrow();
    await f.http.held;
    if (withdrawal === "vault") vaultStore.lock();
    else f.http.abort.abort();
    await pending;
    await vi.waitFor(() =>
      expect(f.http.records.at(-1)).toMatchObject({
        closed: true,
        ended: false,
      }),
    );
    const count = f.http.records.length;
    await expect(start(f, "saved")).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
  },
);
it.each(["test", "save", "saved"])(
  "already-ended original %s caller cannot authenticate a request",
  async (operation) => {
    const f = await setup(operation === "saved");
    const before = f.http.records.length;
    if (operation === "saved") f.caller.abort();
    else {
      const ended = new AbortController();
      ended.abort();
      f.options.signal = ended.signal;
    }
    await expect(start(f, operation)).rejects.toThrow();
    expect(f.http.records).toHaveLength(before);
  },
);
it.each(["edit", "trash", "forget"])(
  "actual saved credential/row %s cannot authenticate another transcription",
  async (change) => {
    const f = await setup(true);
    if (!f.view) throw new Error("Expected saved Scribe");
    const item = vaultStore
      .getSnapshot()
      .items.find((value) => value.kind === "credential");
    if (!item || item.kind !== "credential" || item.method.type !== "token")
      throw new Error("Expected sealed token");
    if (change === "forget") await deleteAiConnection(f.view.connectionId);
    else if (change === "trash") await vaultStore.trashItem(item.id);
    else
      await vaultStore.saveItem({
        ...item,
        method: { ...item.method, token: "edited-scribe-token" },
      });
    const count = f.http.records.length;
    await expect(start(f, "saved")).rejects.toThrow();
    expect(f.http.records).toHaveLength(count);
  },
);
it("preserves original caller method receiver through successful finite transcription", async () => {
  const f = await setup(true);
  await expect(start(f, "saved")).resolves.toMatchObject({
    answer: SCRIBE_TEXT,
  });
  expect(f.runtime.checks).toBeGreaterThan(1);
});

it.each(["test", "save"])(
  "retains the original %s caller signal while a real vault result is held",
  async (operation) => {
    const f = await setup();
    const controller = new AbortController();
    f.options.signal = controller.signal;
    const gate = holdVaultCapture();
    const pending = expect(start(f, operation)).rejects.toThrow();
    await gate.captured;
    f.options.signal = new AbortController().signal;
    controller.abort();
    gate.release();
    await pending;
    expect(f.http.records).toEqual([]);
    expect(readDeviceRows()).toEqual([]);
  },
);
