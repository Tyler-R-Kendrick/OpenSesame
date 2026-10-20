/** Independent HTTPS multipart oracle and Pillow-generated actual 2x3 raster fixtures. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { crc32 } from "node:zlib";
import { z } from "zod";
import { tlsFetch } from "../native-s3-backup.test-support.js";
import type { AiConnectionTransport } from "./types.js";
export const STABILITY_KEY = "owned-stability-generation-key";
export const STABILITY_PROMPT = "A small lighthouse above the sea";
export const RASTER_FIXTURES = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGMUz7vMwMDAxMDAgKAAGSABXvdtWIQAAAAASUVORK5CYII=",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDn6KKK+6PkT//Z",
  webp: "UklGRjoAAABXRUJQVlA4IC4AAAAQAgCdASoCAAMAAUAmJaACdLoB+AH4AAPIAP7vUS/+wdMGXP8V7/0YLgOB7wgA",
} as const;
export function pngChunk(type: string, data: Uint8Array) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
export function pngWithComment(value: string) {
  const original = Buffer.from(RASTER_FIXTURES.png, "base64");
  return Buffer.concat([
    original.subarray(0, -12),
    pngChunk("tEXt", Buffer.from(value)),
    original.subarray(-12),
  ]);
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "stability-owned-tls-"));
  for (let p = directory; ; p = dirname(p)) {
    const st = lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error("Unsafe TLS directory");
    if (p === "/") break;
  }
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
export type StabilityExchange = {
  path: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  fields: [string, string][];
  closed: boolean;
  finished: boolean;
};
function parseMultipart(body: Buffer, mime: string) {
  const match = /^multipart\/form-data; boundary=([-\w]+)$/.exec(mime);
  if (!match) throw new Error("Expected platform multipart boundary");
  const boundary = match[1];
  const text = body.toString("utf8");
  if (
    !text.endsWith(`--${boundary}--`) &&
    !text.endsWith(`--${boundary}--\r\n`)
  )
    throw new Error("Missing multipart terminator");
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part): [string, string] => {
      const field =
        /^\r\nContent-Disposition: form-data; name="([a-z_]+)"\r\n\r\n([\s\S]*)\r\n$/.exec(
          part,
        );
      if (!field) throw new Error("Unexpected multipart field");
      return [field[1], field[2]];
    });
}
type StabilityFixtureReply = {
  image: string;
  finish_reason: string;
  seed: number;
};
function responseBody(mode: string) {
  const body: StabilityFixtureReply = {
    image: RASTER_FIXTURES.png,
    finish_reason: "SUCCESS",
    seed: 23,
  };
  if (mode === "no-seed")
    return { image: body.image, finish_reason: body.finish_reason };
  if (mode === "filtered") body.finish_reason = "CONTENT_FILTERED";
  if (mode === "echo") body.image = STABILITY_KEY;
  if (mode === "decoded-echo")
    body.image = pngWithComment(STABILITY_KEY).toString("base64");
  if (mode === "jpeg") body.image = RASTER_FIXTURES.jpeg;
  if (mode === "bad-base64") body.image = `data:image/png;base64,${body.image}`;
  if (mode === "no-image") return { finish_reason: "SUCCESS", seed: 23 };
  if (mode === "unknown")
    return { ...body, url: "https://untrusted.example/result.png" };
  return body;
}
type FixtureState = { mode: string; current: boolean; held?: ServerResponse };
async function readExchange(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<StabilityExchange> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Request bound");
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  const fields = parseMultipart(
    body,
    String(request.headers["content-type"] ?? ""),
  );
  const row: StabilityExchange = {
    path: request.url ?? "",
    method: request.method ?? "",
    headers: request.headers,
    body,
    fields,
    closed: false,
    finished: false,
  };
  response.on("close", () => {
    row.closed = true;
  });
  response.on("finish", () => {
    row.finished = true;
  });
  return row;
}
function validExchange(
  row: StabilityExchange,
  expectedPath: string,
  model: string,
) {
  const expected: [string, string][] = [
    ["prompt", STABILITY_PROMPT],
    ["model", model],
    ["mode", "text-to-image"],
    ["aspect_ratio", "1:1"],
    ["output_format", "png"],
  ];
  return (
    row.path === expectedPath &&
    row.method === "POST" &&
    row.headers.authorization === `Bearer ${STABILITY_KEY}` &&
    row.headers.accept === "application/json" &&
    JSON.stringify(row.fields) === JSON.stringify(expected) &&
    !row.body.includes(Buffer.from(STABILITY_KEY))
  );
}
function respond(response: ServerResponse, state: FixtureState) {
  if (state.mode === "held-error") {
    response.writeHead(401, { "content-type": "application/json" });
    response.write('{"errors":["');
    state.held = response;
    return;
  }
  if (state.mode.startsWith("http-")) {
    response.writeHead(Number(state.mode.slice(5)));
    response.end(JSON.stringify({ error: STABILITY_KEY }));
    return;
  }
  if (state.mode === "hold-headers") {
    state.held = response;
    return;
  }
  response.writeHead(200, {
    "content-type":
      state.mode === "wrong-mime"
        ? "text/html"
        : "application/json; charset=utf-8",
  });
  if (state.mode === "hold-body") {
    response.write('{"image":"');
    state.held = response;
    return;
  }
  if (state.mode === "oversized")
    response.end(`"${"x".repeat(4 * 1024 * 1024)}"`);
  else
    response.end(
      state.mode === "malformed"
        ? "{"
        : JSON.stringify(responseBody(state.mode)),
    );
}
export async function stabilityTlsFixture(
  baseUrl = "https://api.stability.ai/v2beta/stable-image",
  model = "sd3.5-medium",
) {
  const material = certificate();
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const expectedPath = `${base.pathname}generate/sd3`;
  const records: StabilityExchange[] = [];
  const sockets = new Set<Duplex>();
  const state: FixtureState = {
    mode: "success",
    current: true,
  };
  const controller = new AbortController();
  let requestReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    requestReady = resolve;
  });
  const server = createServer(material, (request, response) => {
    void (async () => {
      const row = await readExchange(request, response);
      records.push(row);
      if (!validExchange(row, expectedPath, model)) {
        response.writeHead(422);
        response.end("invalid oracle request");
      } else respond(response, state);
      requestReady?.();
    })().catch(() => {
      response.destroy();
      requestReady?.();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(material.directory, { recursive: true, force: true });
    throw error;
  }
  const address = z
    .object({
      address: z.literal("127.0.0.1"),
      family: z.literal("IPv4"),
      port: z.number().int().min(1).max(65535),
    })
    .parse(server.address());
  const secure = tlsFetch(material.cert);
  const localOrigin = `https://127.0.0.1:${address.port}`;
  const port: AiConnectionTransport = {
    signal: controller.signal,
    assertCurrent() {
      if (!state.current) throw new Error("Original Stability owner withdrawn");
      controller.signal.throwIfAborted();
    },
    fetch(input, init) {
      const logical = new URL(input);
      if (
        logical.origin !== base.origin ||
        logical.pathname !== expectedPath ||
        logical.search ||
        logical.hash
      )
        throw new Error("Unexpected egress target");
      return secure(localOrigin + logical.pathname, init);
    },
  };
  return {
    records,
    state,
    port,
    ready,
    withdraw() {
      state.current = false;
      controller.abort();
    },
    async close() {
      controller.abort();
      state.held?.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(material.directory, { recursive: true, force: true });
    },
    assertNoSockets() {
      if (sockets.size) throw new Error("Fixture sockets still live");
    },
  };
}
