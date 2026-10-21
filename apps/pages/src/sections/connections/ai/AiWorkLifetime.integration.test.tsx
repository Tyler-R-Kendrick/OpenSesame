/** @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  OLLAMA_MODEL,
  OLLAMA_TEXT,
  ollamaTlsFixture,
} from "@opensesame/app-core/lib/ai-connections/ollama-tls.test-support.js";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SecretBackendActionOwner } from "../secret-backends/useSecretBackendAction.js";
import { useAiOperation } from "./useAiConnection.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup() {
  vi.stubGlobal("crypto", webcrypto);
  const vault = await runtimeFixture();
  const http = await ollamaTlsFixture();
  const signals: AbortSignal[] = [];
  const responses: Response[] = [];
  closes.push(vault.close, http.close);
  const release = bindAiConnectionTransport({
    ...http.port,
    async fetch(input, init) {
      if (!init?.signal) throw new Error("Actual request signal required");
      signals.push(init.signal);
      const response = await http.port.fetch(input, init);
      responses.push(response);
      return response;
    },
  });
  closes.push(async () => release());
  const saved = await saveAiConnection({
    ...aiConnectionDraft("ollama"),
    baseUrl: http.baseUrl,
    model: OLLAMA_MODEL,
  });
  const flash = vi.fn();
  const withdraw = vi.fn();
  const view = renderHook(() =>
    useAiOperation(flash, withdraw, saved.connectionId),
  );
  const owners: SecretBackendActionOwner[] = [];
  const answers: string[] = [];
  let complete = false;
  function start(stream = true) {
    let task = Promise.resolve(false);
    act(() => {
      task = view.result.current.runAi(async (owner) => {
        owners.push(owner);
        const response = await performSavedAiInference(
          saved.connectionId,
          {
            model: OLLAMA_MODEL,
            messages: [{ role: "user", content: "Original owned response" }],
          },
          { signal: owner.signal, assertCurrent: owner.check },
          stream ? (text) => answers.push(text) : undefined,
        );
        expect(response.answer).toBe(OLLAMA_TEXT);
        complete = true;
        return "Actual response finished";
      });
    });
    return task;
  }
  return {
    http,
    signals,
    responses,
    saved,
    flash,
    view,
    owners,
    answers,
    start,
    complete: () => complete,
  };
}

it.each([false, true])(
  "completes actual TLS stream=%s without cancelling the EOF reader or aborting its consumed HTTP during generic retirement",
  async (stream) => {
    const f = await setup();
    const readers = vi.spyOn(ReadableStream.prototype, "getReader");
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    await act(async () => {
      expect(await f.start(stream)).toBe(true);
    });
    expect(f.complete()).toBe(true);
    expect(f.http.records.at(-1)).toMatchObject({ stream, finished: true });
    const response = f.responses.at(-1);
    const index = readers.mock.contexts.findIndex(
      (body) => body === response?.body,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const reader = readers.mock.results[index];
    expect(reader?.type).toBe("return");
    expect(cancel.mock.contexts).not.toContain(reader?.value);
    expect(response?.body?.locked).toBe(false);
    const owner = f.owners[0];
    expect(owner).toBeDefined();
    expect(owner?.current()).toBe(false);
    expect(() => owner?.check()).toThrow(/ended/);
    expect(owner?.signal.aborted).toBe(false);
    expect(f.signals.at(-1)?.aborted).toBe(false);
    expect(f.view.result.current.result).toBe("Actual response finished");
    expect(f.view.result.current.busy).toBe(false);
    expect(f.http.errors).toEqual([]);
  },
);

it.each(["clear", "unmount", "vault", "remove"] as const)(
  "keeps DONE-before-EOF pending and physically closes held TLS on %s withdrawal",
  async (kind) => {
    const f = await setup();
    f.http.state.hold = true;
    f.http.state.doneWithoutEOF = true;
    const task = f.start();
    await waitFor(() => expect(f.answers.join("")).toBe(OLLAMA_TEXT));
    await delay(250);
    expect(f.complete()).toBe(false);
    expect(f.http.records.at(-1)).toMatchObject({
      stream: true,
      finished: false,
      closed: false,
    });
    expect(f.signals.at(-1)?.aborted).toBe(false);
    const start = performance.now();
    await act(async () => {
      if (kind === "clear") f.view.result.current.clear();
      else if (kind === "unmount") f.view.unmount();
      else if (kind === "vault") vaultStore.lock();
      else await deleteAiConnection(f.saved.connectionId);
      expect(await task).toBe(false);
    });
    await waitFor(() => expect(f.http.records.at(-1)?.closed).toBe(true), {
      timeout: 2000,
    });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(f.http.records.at(-1)?.finished).toBe(false);
    expect(f.complete()).toBe(false);
    expect(f.signals.at(-1)?.aborted).toBe(true);
    expect(f.owners[0]?.current()).toBe(false);
    expect(f.http.errors).toEqual([]);
  },
);

it("aborts HTTP ownership after a real invalid TLS inference response and preserves the failure", async () => {
  const f = await setup();
  f.http.state.malformed = true;
  await act(async () => {
    expect(await f.start()).toBe(false);
  });
  expect(f.complete()).toBe(false);
  expect(f.signals.at(-1)?.aborted).toBe(true);
  expect(f.owners[0]?.signal.aborted).toBe(true);
  expect(f.view.result.current.failure).not.toBe("");
  expect(f.flash).toHaveBeenCalledOnce();
  expect(f.http.errors).toEqual([]);
});
