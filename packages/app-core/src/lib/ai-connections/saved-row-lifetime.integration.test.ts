import { afterEach, expect, it, vi } from "vitest";
import { removeDeviceConfigurationDurable } from "../device-connector-records.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "../native-connector-store.js";
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
import { AI_CONNECTION_CLASSIFICATION } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionDraft } from "./types.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
/** Zero prefetch: a second pull proves the real consumer is awaiting more TLS bytes. */
function observePendingRead(response: Response, pending: () => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected actual TLS response body");
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = reader.read();
        reads += 1;
        if (reads === 2) pending();
        try {
          const result = await next;
          if (result.done) {
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}
async function setup() {
  const vault = await runtimeFixture();
  const http = await speechTlsFixture();
  closes.push(vault.close, http.close);
  let pendingRead = () => {};
  const bodyPending = new Promise<void>((resolve) => {
    pendingRead = resolve;
  });
  const port = {
    ...http.port,
    async fetch(input: string | URL, init?: RequestInit) {
      const held = http.state.mode === "held";
      const response = await http.port.fetch(input, init);
      return held ? observePendingRead(response, pendingRead) : response;
    },
  };
  const capture = vi.fn(() => port);
  const release = bindAiConnectionTransport({ ...port, capture });
  closes.push(async () => release());
  const ambient = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("No ambient fetch authority");
  });
  const draft: AiConnectionDraft = {
    providerId: "elevenlabs",
    name: "Owned saved-row Scribe",
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
  return { vault, http, draft, view, input, capture, ambient, bodyPending };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type Workflow = "inference" | "test" | "save";
function workflow(f: Fixture, kind: Workflow) {
  if (kind === "inference")
    return performSavedAiInference(f.view.connectionId, f.input);
  if (kind === "test")
    return testAiConnection(
      { ...f.draft, apiKey: "" },
      f.view.connectionId,
      undefined,
      { audio: ownedSpeechAudio() },
    );
  return saveAiConnection(
    { ...f.draft, apiKey: "" },
    f.view.connectionId,
    undefined,
    { audio: ownedSpeechAudio() },
  );
}
async function edit(id: string) {
  const row = loadNativeConnectorRecord(id);
  if (!row) throw new Error("Missing exact saved Scribe row");
  await updateNativeConnector(
    id,
    { revision: row.revision, fingerprint: row.configuration.fingerprint },
    AI_CONNECTION_CLASSIFICATION,
    (current) => ({
      ...current,
      configuration: {
        ...current.configuration,
        displayName: "Edited saved connection",
      },
    }),
  );
}
it.each([
  ["inference", "remove"],
  ["inference", "edit"],
  ["test", "remove"],
  ["test", "edit"],
  ["save", "remove"],
  ["save", "edit"],
] as const)(
  "closes the actual saved Scribe %s response immediately when its exact row is %s",
  async (kind, change) => {
    const f = await setup();
    const count = f.capture.mock.calls.length;
    f.http.state.mode = "held";
    const result = workflow(f, kind).then(
      () => "accepted",
      () => "refused",
    );
    await f.http.held;
    await f.bodyPending;
    expect(f.capture).toHaveBeenCalledTimes(count + 1);
    if (change === "remove") await deleteAiConnection(f.view.connectionId);
    else await edit(f.view.connectionId);
    expect(await result).toBe("refused");
    await vi.waitFor(() =>
      expect(f.http.records[1]).toMatchObject({ closed: true, ended: false }),
    );
    f.http.release();
    expect(f.http.records).toHaveLength(2);
    expect(f.capture).toHaveBeenCalledTimes(count + 1);
    expect(f.ambient).not.toHaveBeenCalled();
  },
);

it.each(["inference", "test", "save"] as const)(
  "unrelated row changes leave original saved Scribe %s useful and preserve its own save publication",
  async (kind) => {
    const f = await setup();
    const unrelated = await saveAiConnection(
      { ...f.draft, name: "Another original row" },
      undefined,
      undefined,
      { audio: ownedSpeechAudio() },
    );
    const count = f.capture.mock.calls.length;
    f.http.state.mode = "held";
    const result = workflow(f, kind);
    void result.catch(() => undefined);
    await f.http.held;
    await f.bodyPending;
    await edit(unrelated.connectionId);
    await deleteAiConnection(unrelated.connectionId);
    expect(f.http.records.at(-1)).toMatchObject({
      closed: false,
      ended: false,
    });
    f.http.release();
    const output = await result;
    if (kind === "inference")
      expect(output).toMatchObject({ answer: SCRIBE_TEXT });
    else if (kind === "test") expect(output).toBe("Model inference verified");
    else
      expect(output).toMatchObject({
        connectionId: f.view.connectionId,
        status: "connected",
      });
    expect(f.capture).toHaveBeenCalledTimes(count + 1);
    expect(f.ambient).not.toHaveBeenCalled();
  },
);

it.each(["caller", "vault", "route"] as const)(
  "keeps the existing %s physical-close boundary on saved Scribe",
  async (change) => {
    const f = await setup();
    const caller = new AbortController();
    f.http.state.mode = "held";
    const result = performSavedAiInference(f.view.connectionId, f.input, {
      signal: caller.signal,
      assertCurrent: () => caller.signal.throwIfAborted(),
    }).then(
      () => "accepted",
      () => "refused",
    );
    await f.http.held;
    await f.bodyPending;
    if (change === "caller") caller.abort();
    else if (change === "vault") vaultStore.lock();
    else f.http.abort.abort();
    expect(await result).toBe("refused");
    await vi.waitFor(() =>
      expect(f.http.records[1]).toMatchObject({ closed: true, ended: false }),
    );
    expect(f.ambient).not.toHaveBeenCalled();
  },
);

it("physical deletion of an exact committed row has the same withdrawal semantics", async () => {
  const f = await setup();
  f.http.state.mode = "held";
  const result = performSavedAiInference(f.view.connectionId, f.input).then(
    () => "accepted",
    () => "refused",
  );
  await f.http.held;
  await f.bodyPending;
  await removeDeviceConfigurationDurable(f.view.connectionId);
  expect(await result).toBe("refused");
  await vi.waitFor(() =>
    expect(f.http.records[1]).toMatchObject({ closed: true, ended: false }),
  );
});
