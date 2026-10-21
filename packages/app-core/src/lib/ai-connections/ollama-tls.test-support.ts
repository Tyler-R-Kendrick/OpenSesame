/** Independent Ollama-compatible TLS producer: exact saved model, auth and wire shape. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import type { AiConnectionTransport } from "./types.js";

export const OLLAMA_TEXT = "Actual Ollama-compatible native model answer";
export const OLLAMA_MODEL = "library/llama3.2:latest";
export const OLLAMA_KEY = "private-operator-ollama-token";
type Exchange = {
  method: string;
  path: string;
  model: string;
  authenticated: boolean;
  stream: boolean;
  finished: boolean;
  closed: boolean;
};
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "ollama-primary-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
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
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return {
    directory,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}
const bodySchema = z
  .object({
    model: z.literal(OLLAMA_MODEL),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string().min(1).max(8192),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    max_tokens: z.number().int().min(1).max(4096),
    stream: z.boolean(),
  })
  .strict();
type OllamaResponseState = {
  hold: boolean;
  malformed: boolean;
  oversized: boolean;
  reflected: boolean;
};
function service(
  authenticated: boolean,
  records: Exchange[],
  errors: string[],
  state: OllamaResponseState,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const payload = bodySchema.parse(
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        if (
          request.method !== "POST" ||
          request.url !== "/native/v1/chat/completions" ||
          request.headers["content-type"] !== "application/json" ||
          request.headers.authorization !==
            (authenticated ? `Bearer ${OLLAMA_KEY}` : undefined)
        )
          throw new Error(
            "Ollama protocol target, body or authentication mismatch",
          );
        const row: Exchange = {
          method: request.method,
          path: request.url,
          model: payload.model,
          authenticated,
          stream: payload.stream,
          finished: false,
          closed: false,
        };
        records.push(row);
        response.once("finish", () => {
          row.finished = true;
        });
        response.once("close", () => {
          row.closed = true;
        });
        const text = state.reflected ? OLLAMA_KEY : OLLAMA_TEXT;
        if (state.hold) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write(" ");
        } else if (state.malformed) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"choices":[]}');
        } else if (state.oversized) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              choices: [{ message: { content: "x".repeat(600_000) } }],
            }),
          );
        } else if (payload.stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ choices: [{ message: { content: text } }] }),
          );
        }
      } catch {
        errors.push("Ollama protocol oracle refused the actual request");
        response.writeHead(422).end();
      }
    });
  };
}
export async function ollamaTlsFixture(authenticated = false) {
  const cert = certificate();
  const records: Exchange[] = [];
  const errors: string[] = [];
  const sockets = new Set<Duplex>();
  const lifetime = new AbortController();
  const state = {
    hold: false,
    malformed: false,
    oversized: false,
    reflected: false,
  };
  const server = createServer(
    cert,
    service(authenticated, records, errors, state),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const baseUrl = `https://127.0.0.1:${address.port}/native/v1`;
  const port: AiConnectionTransport = {
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    assertEndpointAllowed: (endpoint) => {
      lifetime.signal.throwIfAborted();
      if (endpoint !== baseUrl) throw new Error("Unowned Ollama endpoint");
    },
    fetch: tlsFetch(cert.cert),
  };
  return {
    baseUrl,
    records,
    errors,
    lifetime,
    port,
    state,
    async close() {
      lifetime.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(cert.directory, { recursive: true, force: true });
    },
  };
}
