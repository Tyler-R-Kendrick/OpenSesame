import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { performHostedInference } from "../hosted-inference.js";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "../native-connector-store.js";
import { nativeOAuthGuard } from "../native-oauth-session.js";
import {
  deferred,
  runtimeFixture,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { aiConnectionDraft } from "./presets.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import {
  AI_CONNECTION_CLASSIFICATION,
  readAiConnection,
  savedAiConnections,
} from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import { aiVaultSeams, captureAiVault } from "./vault-guard.js";

let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let lease: AbortController;
let holdNext: boolean;
let mode: "valid" | "invalid" | "oversize";
let held: ServerResponse | undefined;
let started: ReturnType<typeof deferred<void>>;
let closed: ReturnType<typeof deferred<void>>;
const guards: Awaited<ReturnType<typeof captureAiVault>>[] = [];
const signals: AbortSignal[] = [];
const releases: (() => void)[] = [];
const answer = JSON.stringify({
  choices: [{ message: { content: "Actual answer" } }],
});
function project() {
  return savedAiConnections().map(({ draft, view }) => ({
    connectionId: view.connectionId,
    providerId: view.providerId,
    status: view.status,
    method: view.configuration.method,
    model: draft.model,
    endpoint: draft.baseUrl,
  }));
}
beforeEach(async () => {
  vault = await runtimeFixture();
  lease = new AbortController();
  mode = "valid";
  holdNext = false;
  held = undefined;
  started = deferred<void>();
  closed = deferred<void>();
  guards.length = 0;
  signals.length = 0;
  http = await aiHttpFixture((request, response) => {
    const stream = Boolean(JSON.parse(request.body).stream);
    response.setHeader(
      "content-type",
      stream ? "text/event-stream" : "application/json",
    );
    if (holdNext || mode === "oversize") {
      holdNext = false;
      held = response;
      response.on("close", () => {
        if (!response.writableEnded) closed.resolve();
      });
      if (stream)
        response.write(
          'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: [DONE]\n\n',
        );
      if (mode === "oversize") response.write(`"${"x".repeat(512 * 1024)}`);
      started.resolve();
    } else if (mode === "invalid") response.end("{");
    else
      response.end(
        stream
          ? 'data: {"choices":[{"delta":{"content":"Actual answer"}}]}\n\ndata: [DONE]\n\n'
          : answer,
      );
  });
  vi.spyOn(aiVaultSeams, "capture").mockImplementation(async () => {
    const guard = await captureAiVault();
    guards.push(guard);
    return guard;
  });
  const assertCurrent = () => lease.signal.throwIfAborted();
  releases.push(
    bindAiConnectionTransport({
      signal: lease.signal,
      assertCurrent,
      fetch(input, init) {
        if (!init?.signal) throw new Error("Actual request signal missing.");
        signals.push(init.signal);
        return fetch(input, init);
      },
    }),
  );
  releases.push(
    bindHostedModelAuthority({
      fetch,
      assertCurrent,
      connections: project,
      read: (id) => project().find((row) => row.connectionId === id) ?? null,
      execute: async () => {
        throw new Error("Saved endpoint must use actual AI runtime.");
      },
    }),
  );
});
afterEach(async () => {
  held?.destroy();
  for (const release of releases.splice(0).reverse()) release();
  lease.abort();
  vi.restoreAllMocks();
  await http.close();
  await vault.close();
});
function draft() {
  return {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: http.baseUrl,
    model: "test-model",
    apiKey: "actual-vault-lifetime-token",
  };
}
function input() {
  return {
    model: "test-model",
    messages: [{ role: "user" as const, content: "Question" }],
  };
}
function lastGuard() {
  const guard = guards.at(-1);
  if (!guard) throw new Error("Actual captured vault guard missing.");
  return guard;
}
function graceful() {
  const guard = lastGuard();
  expect(guard.signal.aborted).toBe(false);
  expect(() => guard.check()).toThrow();
  expect(signals.at(-1)?.aborted).toBe(false);
  guard.close();
  expect(guard.signal.aborted).toBe(false);
}
it("retires completed actual Test, Save/update cleanup and selected JSON inference without aborting their Fetch", async () => {
  await expect(testAiConnection(draft())).resolves.toBe(
    "Model inference verified",
  );
  graceful();
  const saved = await saveAiConnection(draft());
  graceful();
  const updated = await saveAiConnection(
    { ...draft(), name: "Renamed saved model" },
    saved.connectionId,
  );
  expect(updated.revision).toBe(saved.revision + 1);
  expect(vaultStore.getSnapshot().items).toHaveLength(1);
  graceful();
  await expect(
    performHostedInference(updated.connectionId, input(), {
      fetch,
      signal: lease.signal,
      assertCurrent: () => lease.signal.throwIfAborted(),
    }),
  ).resolves.toMatchObject({ answer: "Actual answer" });
  graceful();
  const chunks: string[] = [];
  await expect(
    performSavedAiInference(updated.connectionId, input(), undefined, (text) =>
      chunks.push(text),
    ),
  ).resolves.toMatchObject({ answer: "Actual answer" });
  expect(chunks).toEqual(["Actual answer"]);
  graceful();
  expect(http.requests).toHaveLength(5);
  vaultStore.lock();
  expect(guards.every((guard) => !guard.signal.aborted)).toBe(true);
});
it("default close aborts an open real capture and cannot be reversed by completed close", async () => {
  const guard = await captureAiVault();
  guard.close();
  guard.close(true);
  expect(guard.signal.aborted).toBe(true);
  expect(() => guard.check()).toThrow();
});
it.each([false, true])(
  "makes close(completed=%s) terminal and still revokes actual vault ownership",
  async (completed) => {
    const guard = await captureAiVault();
    guard.close(completed);
    guard.close(!completed);
    expect(guard.signal.aborted).toBe(!completed);
    expect(() => guard.check()).toThrow();
    vaultStore.lock();
    expect(guard.signal.aborted).toBe(!completed);
  },
);
it("rejects fully drained malformed JSON and keeps error close aborting", async () => {
  mode = "invalid";
  await expect(testAiConnection(draft())).rejects.toThrow();
  expect(lastGuard().signal.aborted).toBe(true);
  expect(() => lastGuard().check()).toThrow();
  expect(signals.at(-1)?.aborted).toBe(true);
  expect(http.requests).toHaveLength(1);
});
const withdrawals = (["vault", "caller", "lease"] as const).flatMap((owner) =>
  [false, true].map((stream) => ({ owner, stream })),
);
it.each(withdrawals)(
  "$owner withdrawal closes held JSON/SSE=$stream before EOF and withholds its answer",
  async ({ owner, stream }) => {
    const saved = await saveAiConnection(draft());
    const caller = new AbortController();
    const firstChunk = deferred<void>();
    const chunks: string[] = [];
    holdNext = true;
    const running = performSavedAiInference(
      saved.connectionId,
      input(),
      {
        signal: caller.signal,
        assertCurrent: () => caller.signal.throwIfAborted(),
      },
      stream
        ? (text) => {
            chunks.push(text);
            firstChunk.resolve();
          }
        : undefined,
    );
    const rejected = expect(running).rejects.toThrow();
    await started.promise;
    if (stream) await firstChunk.promise;
    if (owner === "vault") vaultStore.lock();
    else if (owner === "caller") caller.abort();
    else lease.abort();
    await rejected;
    await closed.promise;
    expect(held?.writableEnded).toBe(false);
    expect(lastGuard().signal.aborted).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(true);
    held?.end(stream ? "data: [DONE]\n\n" : answer);
    expect(chunks).toEqual(stream ? ["Partial"] : []);
  },
);
it("closes an oversized real body early instead of claiming completed release", async () => {
  mode = "oversize";
  await expect(testAiConnection(draft())).rejects.toThrow(/supported size/);
  await closed.promise;
  expect(held?.writableEnded).toBe(false);
  expect(lastGuard().signal.aborted).toBe(true);
});
it("keeps a simultaneous completed operation current when another held operation is cancelled", async () => {
  const saved = await saveAiConnection(draft());
  const caller = new AbortController();
  holdNext = true;
  const pending = performSavedAiInference(saved.connectionId, input(), {
    signal: caller.signal,
    assertCurrent: () => caller.signal.throwIfAborted(),
  });
  const rejected = expect(pending).rejects.toThrow();
  await started.promise;
  const pendingGuard = lastGuard();
  await expect(
    performSavedAiInference(saved.connectionId, input()),
  ).resolves.toMatchObject({ answer: "Actual answer" });
  const completedGuard = lastGuard();
  graceful();
  caller.abort();
  await rejected;
  await closed.promise;
  expect(pendingGuard.signal.aborted).toBe(true);
  expect(completedGuard.signal.aborted).toBe(false);
});
async function changeCommitted(id: string, change: string) {
  if (change === "lock") {
    vaultStore.lock();
    return;
  }
  if (change === "revision") {
    const record = loadNativeConnectorRecord(id);
    if (!record) throw new Error("Actual committed record missing.");
    await updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      AI_CONNECTION_CLASSIFICATION,
      (current) => ({
        ...current,
        runtime: { ...current.runtime, verifiedAt: null },
      }),
    );
    return;
  }
  const token = vaultStore.getSnapshot().items[0];
  if (!token || token.kind !== "credential" || token.method.type !== "token")
    throw new Error("Actual replacement Token missing.");
  await vaultStore.saveItem({
    ...token,
    method: { ...token.method, token: "unverified-cleanup-replacement" },
  });
}
it.each(["lock", "revision", "credential"])(
  "withholds Save success after real old-custody cleanup %s change",
  async (change) => {
    const saved = await saveAiConnection(draft());
    const withdraw = vaultStore.withdrawItems.bind(vaultStore);
    vi.spyOn(vaultStore, "withdrawItems").mockImplementation(
      async (...args) => {
        await withdraw(...args);
        await changeCommitted(saved.connectionId, change);
      },
    );
    const publicDraft = readAiConnection(saved.connectionId);
    if (!publicDraft) throw new Error("Actual saved public draft missing.");
    await expect(
      saveAiConnection(
        { ...publicDraft, apiKey: "explicit-new-cleanup-token" },
        saved.connectionId,
      ),
    ).rejects.toThrow();
    expect(http.requests).toHaveLength(2);
    expect(lastGuard().signal.aborted).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(true);
    expect(() => lastGuard().check()).toThrow();
  },
);
