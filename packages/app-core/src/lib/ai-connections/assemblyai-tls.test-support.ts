/** Independent owned TLS oracle; no production request/parser builders reused. */
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

export const ASSEMBLY_KEY = "owned-assemblyai-project-key";
export const ASSEMBLY_TEXT = "Find my recorded deployment notes";
export const ASSEMBLY_ID = "6f1578be-7785-4af0-8943-87cfd3bafc2d";
export type AssemblyPhase = "upload" | "create" | "poll" | "delete";
export type AssemblyExchange = {
  path: string;
  method: string;
  authorization: string;
  mime: string;
  accept: string;
  body: Buffer;
  phase?: AssemblyPhase;
  authenticated: boolean;
  ended: boolean;
  closed: boolean;
};
type AssemblyJobResponse = {
  id: string;
  status: string;
  text: string;
  error: string | null;
  speech_model_used: string | null;
  is_deleted?: boolean | null;
  debug?: string;
  urls: { get: string; delete: string };
};
type AssemblyUploadResponse = { upload_url: string; debug?: string };
type AssemblyFixturePayload = AssemblyJobResponse | AssemblyUploadResponse;
export type AssemblyFixtureOptions = {
  baseUrl?: string;
  model?: string;
  id?: string;
  upload?: string;
};
export type AssemblyFixtureState = {
  mode: string;
  phase: AssemblyPhase;
  hold?: AssemblyPhase;
  statuses: string[];
  uploadUrl: string;
  heldResponse?: ServerResponse;
  heldPayload?: AssemblyFixturePayload;
  onRequest?: (phase: AssemblyPhase) => void;
};
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "assemblyai-owned-tls-"));
  for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
    const st = lstatSync(ancestor);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error("TLS parent must be a regular directory");
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
async function exchange(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<AssemblyExchange> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Native request bound");
    chunks.push(Buffer.from(chunk));
  }
  const row: AssemblyExchange = {
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
function ownedAudio(body: Buffer) {
  const wav =
    body.length >= 44 &&
    body.subarray(0, 4).toString() === "RIFF" &&
    body.subarray(8, 12).toString() === "WAVE";
  const webm = body
    .subarray(0, 4)
    .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if ((!wav && !webm) || body.length > 1024 * 1024 - 16 * 1024)
    throw new Error("Expected exact finite local audio");
}
function jobText(mode: string) {
  if (mode === "empty") return "";
  if (mode === "whitespace") return " \n ";
  if (mode === "large-text") return "a".repeat(32769);
  if (mode === "unicode-text") return "é".repeat(20000);
  if (mode === "echo") return ASSEMBLY_KEY;
  return ASSEMBLY_TEXT;
}
function job(id: string, status: string, model: string, mode: string) {
  const response: AssemblyJobResponse = {
    id:
      mode === "wrong-id"
        ? "11111111-1111-4111-8111-111111111111"
        : mode === "bad-id"
          ? "../foreign"
          : mode === "id-echo"
            ? ASSEMBLY_KEY
            : id,
    status:
      mode === "unknown-status"
        ? "deleted"
        : mode === "provider-error"
          ? "error"
          : status,
    text: jobText(mode),
    error:
      mode === "provider-error" || mode === "error-and-text"
        ? "upstream-private-failure"
        : null,
    speech_model_used:
      mode === "wrong-model"
        ? "unrequested-model"
        : mode === "nullable-model"
          ? null
          : model,
    urls: {
      get: "https://untrusted.example/foreign",
      delete: "https://untrusted.example/delete",
    },
  };
  response.is_deleted = mode === "deleted" ? true : null;
  if (mode === "metadata-echo") response.debug = ASSEMBLY_KEY;
  return response;
}
type OracleOwner = { uploaded: boolean; created: boolean; polls: number };
function createOwnedJob(
  row: AssemblyExchange,
  model: string,
  expectedUpload: string,
  owner: OracleOwner,
) {
  if (!owner.uploaded || owner.created || row.mime !== "application/json")
    throw new Error("Wrong create ordering or retry");
  z.object({
    audio_url: z.literal(expectedUpload),
    speech_models: z.tuple([z.literal(model)]),
    language_code: z.literal("en"),
  })
    .strict()
    .parse(JSON.parse(row.body.toString()));
  owner.created = true;
}
function requestPhase(
  row: AssemblyExchange,
  prefix: string,
  model: string,
  id: string,
  expectedUpload: string,
  owner: OracleOwner,
): AssemblyPhase {
  if (row.authorization !== ASSEMBLY_KEY || row.accept !== "application/json")
    throw new Error("Wrong raw project authorization");
  if (row.path === `${prefix}/upload` && row.method === "POST") {
    if (owner.uploaded || row.mime !== "application/octet-stream")
      throw new Error("Wrong upload contract or retry");
    ownedAudio(row.body);
    owner.uploaded = true;
    return "upload";
  }
  if (row.path === `${prefix}/transcript` && row.method === "POST") {
    createOwnedJob(row, model, expectedUpload, owner);
    return "create";
  }
  if (
    owner.created &&
    row.path === `${prefix}/transcript/${id}` &&
    ["GET", "DELETE"].includes(row.method)
  ) {
    if (row.body.length || row.mime)
      throw new Error("Unexpected job request body or content type");
    return row.method === "DELETE" ? "delete" : "poll";
  }
  throw new Error("Unowned endpoint or operation");
}
function respond(
  response: ServerResponse,
  mode: string,
  phase: AssemblyPhase,
  state: AssemblyFixtureState,
  payload: AssemblyFixturePayload,
  held: () => void,
) {
  response.setHeader(
    "content-type",
    mode === "wrong-mime" ? "text/html" : "application/json",
  );
  const error = new Map([
    ["unauthorized", 401],
    ["forbidden", 403],
    ["limited", 429],
    ["redirect", 302],
  ]).get(mode);
  if (error) {
    response.setHeader("location", "https://untrusted.example/leak");
    response.statusCode = error;
    if (state.hold === phase) {
      state.heldResponse = response;
      response.flushHeaders();
      response.write(" ");
      held();
    } else response.end(JSON.stringify({ error: ASSEMBLY_KEY }));
  } else if (state.hold === phase) {
    state.heldResponse = response;
    state.heldPayload = payload;
    response.flushHeaders();
    response.write(" ");
    held();
  } else if (mode === "malformed") response.end('{"id":');
  else if (mode === "oversized-body") response.end(" ".repeat(512 * 1024 + 1));
  else response.end(JSON.stringify(payload));
}
function service(
  prefix: string,
  model: string,
  id: string,
  expectedUpload: string,
  records: AssemblyExchange[],
  state: AssemblyFixtureState,
  held: () => void,
) {
  const owner: OracleOwner = { uploaded: false, created: false, polls: 0 };
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const row = await exchange(request, response);
      records.push(row);
      const phase = requestPhase(row, prefix, model, id, expectedUpload, owner);
      row.phase = phase;
      row.authenticated = true;
      const mode = phase === state.phase ? state.mode : "complete";
      state.onRequest?.(phase);
      const status =
        phase === "create"
          ? "queued"
          : phase === "poll"
            ? (state.statuses[
                Math.min(owner.polls++, state.statuses.length - 1)
              ] ?? "queued")
            : "completed";
      const payload: AssemblyFixturePayload =
        phase === "upload"
          ? { upload_url: state.uploadUrl }
          : job(id, status, model, mode);
      if (mode === "metadata-echo") payload.debug = ASSEMBLY_KEY;
      respond(response, mode, phase, state, payload, held);
    } catch {
      if (!response.headersSent)
        response.writeHead(400, { "content-type": "application/json" });
      response.end("{}");
    }
  };
}
export async function assemblyTlsFixture(options: AssemblyFixtureOptions = {}) {
  const baseUrl = options.baseUrl ?? "https://api.assemblyai.com/v2";
  const expectedModel = options.model ?? "universal-3-5-pro";
  const id = options.id ?? ASSEMBLY_ID;
  const upload =
    options.upload ?? "https://cdn.assemblyai.com/upload/owned-local-audio";
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const records: AssemblyExchange[] = [];
  const state: AssemblyFixtureState = {
    mode: "complete",
    phase: "poll",
    statuses: ["processing", "completed"],
    uploadUrl: upload,
  };
  const tls = certificate();
  const sockets = new Set<Duplex>();
  let resolveHeld = () => {};
  const held = new Promise<void>((resolve) => {
    resolveHeld = resolve;
  });
  const server = createServer(
    tls,
    service(prefix, expectedModel, id, upload, records, state, resolveHeld),
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
        ![
          `${prefix}/upload`,
          `${prefix}/transcript`,
          `${prefix}/transcript/${id}`,
        ].includes(url.pathname) ||
        url.search ||
        url.hash
      )
        throw new Error("Not the original configured API authority");
      return fetcher(new URL(url.pathname, origin), init);
    },
  };
  return {
    baseUrl,
    id,
    upload,
    records,
    state,
    held,
    port,
    abort,
    release() {
      state.heldResponse?.end(JSON.stringify(state.heldPayload));
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
