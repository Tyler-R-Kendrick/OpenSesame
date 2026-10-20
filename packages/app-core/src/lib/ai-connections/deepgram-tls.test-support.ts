/** Independently owned raw-audio TLS service; no production builder or parser defines the oracle. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import type { AiConnectionTransport } from "./types.js";

export const DEEPGRAM_TOKEN = "owned-deepgram-primary-token";
export const DEEPGRAM_TEXT = "search the recorded command";

function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "deepgram-primary-tls-"));
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    const state = lstatSync(ancestor);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("Owned TLS parent must be a regular directory");
    if (ancestor === "/") break;
  }
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
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  };
}

export type DeepgramExchange = {
  path: string;
  method: string;
  authorization: string;
  mime: string;
  accept: string;
  body: Buffer;
  authenticated: boolean;
  ended: boolean;
  closed: boolean;
};
type DeepgramState = { mode: string; heldResponse?: ServerResponse };
async function exchange(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Native request bound");
    chunks.push(Buffer.from(chunk));
  }
  const row: DeepgramExchange = {
    path: request.url ?? "",
    method: request.method ?? "",
    authorization: String(request.headers.authorization ?? ""),
    mime: String(request.headers["content-type"] ?? ""),
    accept: String(request.headers.accept ?? ""),
    body: Buffer.concat(chunks),
    authenticated: false,
    ended: false,
    closed: false,
  };
  response.on("finish", () => {
    row.ended = true;
  });
  response.on("close", () => {
    row.closed = true;
  });
  return row;
}
function validateRequest(
  row: DeepgramExchange,
  prefix: string,
  expectedModel: string,
) {
  const expected = `${prefix}/listen?model=${encodeURIComponent(expectedModel)}&smart_format=true&language=en&multichannel=false`;
  if (row.method !== "POST" || row.path !== expected)
    throw new Error("Unowned operation target or query");
  if (row.accept !== "application/json")
    throw new Error("Expected JSON acceptance");
  if (row.body.length < 4 || row.body.length >= 1024 * 1024)
    throw new Error("Owned audio bound");
  const wav =
    row.mime === "audio/wav" &&
    row.body.length >= 44 &&
    row.body.subarray(0, 4).toString() === "RIFF" &&
    row.body.subarray(8, 12).toString() === "WAVE";
  const webm =
    row.mime === "audio/webm" &&
    row.body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!wav && !webm) throw new Error("Expected raw owned WAV/WebM");
}
function transcript(mode: string) {
  if (mode === "empty") return "";
  if (mode === "whitespace") return "   \n ";
  if (mode === "oversized-text") return "a".repeat(32769);
  if (mode === "multibyte-text") return "é".repeat(20000);
  if (mode === "echo") return DEEPGRAM_TOKEN;
  return DEEPGRAM_TEXT;
}
function result(mode: string) {
  const channel = {
    alternatives: [
      { transcript: transcript(mode), confidence: 0.99, words: [] },
    ],
  };
  const payload = {
    metadata: {
      request_id: "owned-deepgram-request",
      duration: 0.2,
      channels: 1,
    },
    results: { channels: [channel] },
    untrusted_url: "https://untrusted.example/transcript",
  };
  if (mode === "provider-error")
    return { ...payload, err_code: "BAD", err_msg: "must not consume" };
  if (mode === "category-error")
    return {
      ...payload,
      category: "INVALID_JSON",
      message: "must not consume",
    };
  if (mode === "accepted") return { request_id: "accepted-is-not-transcribed" };
  if (mode === "missing-results") return { metadata: payload.metadata };
  if (mode === "missing-transcript")
    return { results: { channels: [{ alternatives: [{}] }] } };
  if (mode === "extra-channel") payload.results.channels.push(channel);
  if (mode === "empty-alternatives") channel.alternatives = [];
  if (mode === "first-alternative")
    channel.alternatives.push({
      transcript: "ignore this alternative",
      confidence: 0.1,
      words: [],
    });
  return payload;
}
function deepgramService(
  prefix: string,
  expectedModel: string,
  records: DeepgramExchange[],
  state: DeepgramState,
  resolveHeld: () => void,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const row = await exchange(request, response);
      records.push(row);
      response.setHeader(
        "content-type",
        state.mode === "wrong-mime" ? "text/html" : "application/json",
      );
      if (
        row.authorization !== `Token ${DEEPGRAM_TOKEN}` ||
        state.mode === "unauthorized"
      ) {
        response.writeHead(401).end(
          JSON.stringify({
            err_code: "INVALID_AUTH",
            err_msg: DEEPGRAM_TOKEN,
          }),
        );
        return;
      }
      if (["forbidden", "payment", "limited"].includes(state.mode)) {
        response
          .writeHead(
            state.mode === "forbidden"
              ? 403
              : state.mode === "payment"
                ? 402
                : 429,
          )
          .end("{}");
        return;
      }
      validateRequest(row, prefix, expectedModel);
      row.authenticated = true;
      if (state.mode === "held") {
        state.heldResponse = response;
        response.flushHeaders();
        response.write('{"results":');
        resolveHeld();
        return;
      }
      if (state.mode === "oversized-body")
        response.end(" ".repeat(512 * 1024 + 1));
      else if (state.mode === "malformed") response.end('{"results":');
      else {
        if (state.mode === "accepted") response.statusCode = 202;
        response.end(JSON.stringify(result(state.mode)));
      }
    } catch {
      response.writeHead(400).end("{}");
    }
  };
}

export async function deepgramTlsFixture(
  baseUrl = "https://api.deepgram.com/v1",
  expectedModel = "nova-3",
) {
  const tls = certificate();
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const records: DeepgramExchange[] = [];
  const sockets = new Set<Duplex>();
  const state: DeepgramState = {
    mode: "complete",
  };
  let resolveHeld = () => {};
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const server = createServer(
    tls,
    deepgramService(prefix, expectedModel, records, state, resolveHeld),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z.object({ port: z.number() }).parse(server.address());
  const origin = `https://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  const fetcher = tlsFetch(tls.cert);
  const port: AiConnectionTransport = {
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    fetch(input, init) {
      const url = new URL(input);
      if (url.origin !== base.origin || url.pathname !== `${prefix}/listen`)
        throw new Error("Unowned transcription target");
      return fetcher(new URL(url.pathname + url.search, origin), init);
    },
  };
  return {
    baseUrl,
    records,
    port,
    abort,
    state,
    held,
    release() {
      state.heldResponse?.end(
        `${JSON.stringify({
          channels: [{ alternatives: [{ transcript: DEEPGRAM_TEXT }] }],
        })}}`,
      );
    },
    async close() {
      abort.abort();
      const stopped = once(server, "close");
      const closed = [...sockets].map((socket) => once(socket, "close"));
      server.close();
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      if (sockets.size) throw new Error("Owned TLS sockets remain");
      rmSync(tls.directory, { recursive: true, force: true });
    },
  };
}
