/** Independently owned TLS Scribe verifier; no production request/response builder reused. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { tlsFetch } from "../test/native-s3-backup-fixtures.js";
import type { AiConnectionTransport } from "./types.js";
export const SCRIBE_TOKEN = "owned-scribe-primary-token";
export const SCRIBE_TEXT = "search actual recorded command";
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "scribe-primary-tls-"));
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    const st = lstatSync(ancestor);
    if (!st.isDirectory() || st.isSymbolicLink())
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

/** A real 200ms PCM WAV: independent fixture, not a production serialization helper. */
export function ownedSpeechAudio() {
  const count = 1600;
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(Buffer.from("RIFF"));
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(Buffer.from("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(Buffer.from("data"), 36);
  view.setUint32(40, count * 2, true);
  for (let index = 0; index < count; index++)
    view.setInt16(
      44 + index * 2,
      Math.round(Math.sin((index * Math.PI * 440) / 4000) * 8000),
      true,
    );
  return { mimeType: "audio/wav", bytes };
}
type Exchange = {
  path: string;
  method: string;
  key: string;
  body: Buffer;
  authenticated: boolean;
  ended: boolean;
  closed: boolean;
  model: string;
  audio: Buffer | null;
};
function multipartField(part: string) {
  const index = part.indexOf("\r\n\r\n");
  const headers = part.slice(0, index);
  const name = /Content-Disposition: form-data; name="([^"\r\n]+)"/i.exec(
    headers,
  )?.[1];
  if (!name || index < 0 || !part.endsWith("\r\n"))
    throw new Error("Invalid multipart field");
  return {
    name,
    body: Buffer.from(part.slice(index + 4, -2), "latin1"),
    headers,
  };
}
function validateOwnedAudio(audio: Buffer, headers: string) {
  if (audio.length < 44 || audio.length >= 1024 * 1024)
    throw new Error("Owned audio bound");
  const wav =
    audio.subarray(0, 4).toString() === "RIFF" &&
    audio.subarray(8, 12).toString() === "WAVE" &&
    /Content-Type: audio\/wav/i.test(headers);
  const webm =
    audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    /Content-Type: audio\/webm/i.test(headers);
  if (!wav && !webm) throw new Error("Expected actual owned WAV/WebM");
}
function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /^multipart\/form-data; boundary=([^;\r\n]+)$/.exec(
    contentType,
  )?.[1];
  if (!boundary) throw new Error("Expected owned multipart");
  const parts = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
  const fields = new Map<string, { body: Buffer; headers: string }>();
  for (const part of parts) {
    const field = multipartField(part);
    if (fields.has(field.name)) throw new Error("Duplicate multipart field");
    fields.set(field.name, field);
  }
  if (fields.size !== 2 || !fields.has("model_id") || !fields.has("file"))
    throw new Error("Unexpected transcription fields/URL/webhook");
  const file = fields.get("file");
  const audio = file?.body;
  if (!file || !audio) throw new Error("Missing local audio");
  validateOwnedAudio(audio, file.headers);
  return { model: fields.get("model_id")?.body.toString() ?? "", audio };
}
async function exchange(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Native request bound");
    chunks.push(Buffer.from(chunk));
  }
  const row: Exchange = {
    path: request.url ?? "",
    method: request.method ?? "",
    key: String(request.headers["xi-api-key"] ?? ""),
    body: Buffer.concat(chunks),
    authenticated: false,
    ended: false,
    closed: false,
    model: "",
    audio: null,
  };
  response.on("finish", () => {
    row.ended = true;
  });
  response.on("close", () => {
    row.closed = true;
  });
  return row;
}
function transcriptText(mode: string): string {
  if (mode === "empty") return "";
  if (mode === "oversized-text") return "a".repeat(32769);
  if (mode === "multibyte-text") return "é".repeat(20000);
  if (mode === "echo") return SCRIBE_TOKEN;
  return SCRIBE_TEXT;
}
type ScribeState = { mode: string };
function scribeService(
  prefix: string,
  records: Exchange[],
  state: ScribeState,
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
        row.key !== SCRIBE_TOKEN ||
        ["unauthorized", "forbidden"].includes(state.mode)
      ) {
        response.writeHead(state.mode === "forbidden" ? 403 : 401).end("{}");
        return;
      }
      if (row.method !== "POST" || row.path !== `${prefix}/speech-to-text`)
        throw new Error("Unowned operation target");
      const parsed = parseMultipart(
        row.body,
        String(request.headers["content-type"]),
      );
      row.model = parsed.model;
      row.audio = parsed.audio;
      if (parsed.model !== "scribe_v2") throw new Error("Wrong saved model");
      row.authenticated = true;
      if (state.mode === "held") {
        response.flushHeaders();
        response.write('{"text":');
        resolveHeld();
        return;
      }
      const text = transcriptText(state.mode);
      if (state.mode === "oversized-body")
        response.end(" ".repeat(512 * 1024 + 1));
      else if (state.mode === "malformed") response.end('{"text":');
      else if (state.mode === "provider-error")
        response.end(JSON.stringify({ text, error: "must not consume" }));
      else
        response.end(
          JSON.stringify({
            text,
            language_code: "en",
            words: [],
            urls: { artifact: "https://untrusted.example/transcript" },
          }),
        );
    } catch {
      response.writeHead(400).end("{}");
    }
  };
}
export async function speechTlsFixture(
  baseUrl = "https://api.elevenlabs.io/v1",
) {
  const tls = certificate();
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const records: Exchange[] = [];
  const sockets = new Set<Duplex>();
  const state = { mode: "complete" };
  let resolveHeld = () => {};
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const server = createServer(
    tls,
    scribeService(prefix, records, state, resolveHeld),
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
      if (
        url.origin !== base.origin ||
        url.pathname !== `${prefix}/speech-to-text`
      )
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
