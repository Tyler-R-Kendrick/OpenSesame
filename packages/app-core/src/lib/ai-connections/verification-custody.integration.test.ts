import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadNativeConnectorRecord } from "../native-connector-store.js";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { aiConnectionDraft } from "./presets.js";
import { saveAiConnection, testAiConnection } from "./runtime.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import type { AiConnectionTransport } from "./types.js";

const KEY = "owned-text-custody-key";
const REPLACEMENT = "owned-replacement-custody-key";
const MODEL = "owned-chat-model";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "ai-custody-https-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    return {
      directory,
      key: readFileSync(join(directory, "key.pem")),
      cert: readFileSync(join(directory, "cert.pem")),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
type TextState = { hold: boolean; held?: ServerResponse };
type Exchange = { key: string; closed: boolean; finished: boolean };
async function textTlsFixture() {
  const tls = certificate();
  const sockets = new Set<Duplex>();
  const records: Exchange[] = [];
  const state: TextState = { hold: false };
  const server = createServer(tls, (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 8192) request.destroy();
    });
    request.on("end", () => {
      const row = {
        key: String(request.headers.authorization ?? ""),
        closed: false,
        finished: false,
      };
      records.push(row);
      response.on("close", () => {
        row.closed = true;
      });
      response.on("finish", () => {
        row.finished = true;
      });
      const parsed = z
        .object({
          model: z.literal(MODEL),
          messages: z.tuple([
            z
              .object({
                role: z.literal("user"),
                content: z.literal("Reply with OK."),
              })
              .strict(),
          ]),
          max_completion_tokens: z.literal(16),
          stream: z.literal(false),
        })
        .strict()
        .safeParse(JSON.parse(body));
      if (
        request.method !== "POST" ||
        request.url !== "/v1/chat/completions" ||
        !parsed.success ||
        ![`Bearer ${KEY}`, `Bearer ${REPLACEMENT}`].includes(row.key)
      ) {
        response.writeHead(422).end("Unexpected protocol request");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (state.hold) {
        state.held = response;
        response.write('{"choices":[');
      } else response.end('{"choices":[{"message":{"content":"Verified"}}]}');
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tls.directory, { recursive: true, force: true });
    throw error;
  }
  const address = z
    .object({
      address: z.literal("127.0.0.1"),
      family: z.literal("IPv4"),
      port: z.number().int().min(1).max(65535),
    })
    .parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  const secure = tlsFetch(tls.cert);
  const lifetime = new AbortController();
  const port: AiConnectionTransport = {
    signal: lifetime.signal,
    assertCurrent() {
      lifetime.signal.throwIfAborted();
    },
    fetch(input, init) {
      const url = new URL(input);
      if (
        url.origin !== origin ||
        url.pathname !== "/v1/chat/completions" ||
        url.search ||
        url.hash
      )
        throw new Error("Unexpected original route");
      return secure(input, init);
    },
  };
  return {
    state,
    records,
    port,
    baseUrl: `${origin}/v1`,
    finish() {
      state.held?.end('{"message":{"content":"Verified"}}]}');
    },
    async close() {
      lifetime.abort();
      state.held?.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
async function setup() {
  const vault = await runtimeFixture();
  closes.push(vault.close);
  const http = await textTlsFixture();
  closes.push(http.close);
  const capture = vi.fn(() => http.port);
  const unbind = bindAiConnectionTransport({ ...http.port, capture });
  closes.push(async () => unbind());
  const draft = {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: http.baseUrl,
    model: MODEL,
    apiKey: KEY,
  };
  const saved = await saveAiConnection(draft);
  const token = vaultStore
    .getSnapshot()
    .items.find((item) => item.kind === "credential");
  if (!token || token.kind !== "credential" || token.method.type !== "token")
    throw new Error("Actual sealed credential missing");
  return { vault, http, capture, draft, saved, token };
}
it.each([
  ["test", "edit"],
  ["test", "delete"],
  ["save", "edit"],
  ["save", "delete"],
] as const)(
  "%s refuses credential %s and physically drains the original held TLS request within2s",
  async (operation, change) => {
    const f = await setup();
    const before = loadNativeConnectorRecord(f.saved.connectionId);
    const retained = readAiConnection(f.saved.connectionId);
    if (!retained) throw new Error("Saved connection missing");
    f.http.state.hold = true;
    const execute = operation === "test" ? testAiConnection : saveAiConnection;
    const pending = execute(retained, f.saved.connectionId).then(
      () => true,
      () => false,
    );
    await expect
      .poll(() => f.http.state.held !== undefined, { timeout: 1500 })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.http.records.at(-1)?.closed).toBe(false);
    const start = performance.now();
    if (change === "edit") {
      if (f.token.method.type !== "token") throw new Error("Expected token");
      await vaultStore.saveItem({
        ...f.token,
        method: { ...f.token.method, token: REPLACEMENT },
      });
    } else {
      await vaultStore.trashItem(f.token.id);
      await vaultStore.purgeItem(f.token.id);
    }
    try {
      await expect
        .poll(() => f.http.records.at(-1)?.closed, { timeout: 1500 })
        .toBe(true);
      expect(performance.now() - start).toBeLessThan(2000);
    } finally {
      f.http.finish();
      expect
        .soft(
          await pending,
          "Changed credentials cannot authenticate held work",
        )
        .toBe(false);
      expect
        .soft(
          loadNativeConnectorRecord(f.saved.connectionId),
          "No stale key or verification may replace the row",
        )
        .toEqual(before);
    }
    expect(f.capture).toHaveBeenCalledTimes(2);
  },
);
it.each(["test", "save"] as const)(
  "unchanged %s credentials accept the real response and settle the original socket normally",
  async (operation) => {
    const f = await setup();
    f.http.state.hold = true;
    const retained = readAiConnection(f.saved.connectionId);
    if (!retained) throw new Error("Saved connection missing");
    const result =
      operation === "test"
        ? testAiConnection(retained, f.saved.connectionId)
        : saveAiConnection(retained, f.saved.connectionId);
    await expect
      .poll(() => f.http.state.held !== undefined, { timeout: 1500 })
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.http.records.at(-1)?.closed).toBe(false);
    f.http.finish();
    await result;
    await expect
      .poll(() => f.http.records.at(-1)?.finished, { timeout: 1500 })
      .toBe(true);
    expect(f.capture).toHaveBeenCalledTimes(2);
  },
);
it("legitimate Save rotation releases the old credential observer only after committed replacement", async () => {
  const f = await setup();
  const before = loadNativeConnectorRecord(f.saved.connectionId);
  const retained = readAiConnection(f.saved.connectionId);
  if (!retained) throw new Error("Saved connection missing");
  const view = await saveAiConnection(
    { ...retained, apiKey: REPLACEMENT },
    f.saved.connectionId,
  );
  expect(view.revision).toBe((before?.revision ?? 0) + 1);
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === KEY,
      ),
  ).toBe(false);
  expect(
    vaultStore
      .getSnapshot()
      .items.filter(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === REPLACEMENT,
      ),
  ).toHaveLength(1);
  await expect(
    testAiConnection({ ...retained, apiKey: "" }, f.saved.connectionId),
  ).resolves.toBe("Model inference verified");
});
