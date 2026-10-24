/**
 * Test-only loopback fixture for native S3 encrypted vault backup.
 *
 * Under `test/` deliberately: it mints a localhost certificate with
 * `node:child_process` and reads it with `node:fs`, and
 * `scripts/mtls/mtls-static-imports.mjs` (AT-STATIC-IMPORTS) treats
 * everything else under `src/` as a shipped source that may not import a
 * native module. Nothing the browser loads imports this file.
 */

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duplex, Readable } from "node:stream";
import { overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import { z } from "zod";
import type { NativeProviderTransport } from "../native-connector-transport.js";
import { configureNativeS3 } from "../native-s3.js";
import { runtimeFixture } from "../secret-backends/runtime.test-support.js";

/** Real verified HTTPS sockets and response streams, not synthetic fetch success. */
export function tlsFetch(ca: Uint8Array): typeof fetch {
  return async (input, init) => {
    const outgoing = new Request(input, init);
    const body = Buffer.from(await outgoing.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        outgoing.url,
        {
          ca: Buffer.from(ca),
          method: outgoing.method,
          headers: Object.fromEntries(outgoing.headers),
          signal: outgoing.signal,
        },
        (incoming) => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2)
            headers.append(
              incoming.rawHeaders[index] ?? "",
              incoming.rawHeaders[index + 1] ?? "",
            );
          const stream: BodyInit = overlapCast(Readable.toWeb(incoming));
          resolve(
            new Response(stream, { status: incoming.statusCode, headers }),
          );
        },
      );
      request.once("error", reject);
      request.end(body);
    });
  };
}
export type S3Exchange = {
  method: string;
  path: string;
  conditional: string;
  bytes: number;
  closed: boolean;
  premature: boolean;
};
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-s3-backup-"));
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
function listing(bucket: string, prefix: string) {
  const escapeXml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><IsTruncated>false</IsTruncated></ListBucketResult>`;
}

type ProtocolState = {
  objects: Map<string, Buffer>;
  requests: S3Exchange[];
  denied: number;
  hold: string;
  held?: ServerResponse;
  heldRow?: S3Exchange;
  corrupt: boolean;
  errors: Error[];
};
function objectPayload(method: string, stored: Buffer, corrupt: boolean) {
  if (method !== "GET") return Buffer.alloc(0);
  return corrupt ? stored.subarray(0, Math.floor(stored.length / 2)) : stored;
}
async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  state: ProtocolState,
  prefix: string,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const url = new URL(request.url ?? "/", "https://localhost");
  const path = decodeURIComponent(url.pathname);
  const row: S3Exchange = {
    method: request.method ?? "GET",
    path,
    conditional: String(request.headers["if-none-match"] ?? ""),
    bytes: bytes.length,
    closed: false,
    premature: false,
  };
  state.requests.push(row);
  response.once("close", () => {
    row.closed = true;
    row.premature = !response.writableEnded;
  });
  if (state.denied && !url.searchParams.has("list-type")) {
    response.writeHead(state.denied);
    response.end();
    return;
  }
  if (url.searchParams.get("list-type") === "2") {
    response.end(listing("test-bucket", prefix));
    return;
  }
  if (row.method === "PUT") {
    if (row.conditional !== "*") {
      response.writeHead(400);
      response.end();
      return;
    }
    if (state.objects.has(path)) {
      response.writeHead(412);
      response.end();
      return;
    }
    state.objects.set(path, bytes);
  }
  const stored = state.objects.get(path);
  if (!stored) {
    response.writeHead(404);
    response.end();
    return;
  }
  const payload = objectPayload(row.method, stored, state.corrupt);
  response.writeHead(200, { "content-type": "application/octet-stream" });
  if (row.method === state.hold) {
    state.held = response;
    state.heldRow = row;
    response.flushHeaders();
    if (payload.length) response.write(payload.subarray(0, 12));
    return;
  }
  response.end(payload);
}

export async function nativeS3BackupFixture(prefix = "vault/") {
  const local = await runtimeFixture();
  const tls = certificate();
  const objects = new Map<string, Buffer>();
  const requests: S3Exchange[] = [];
  const sockets = new Set<Duplex>();
  const state: ProtocolState = {
    objects,
    requests,
    denied: 0,
    hold: "",
    corrupt: false,
    errors: [],
  };
  const server = createServer(tls, (request, response) => {
    void receive(request, response, state, prefix).catch((error: Error) => {
      state.errors.push(error);
      response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const provider = new AbortController();
  const action = new AbortController();
  const transport: NativeProviderTransport = {
    fetch: tlsFetch(tls.cert),
    signal: provider.signal,
    assertCurrent: () => provider.signal.throwIfAborted(),
  };
  const draft = {
    providerId: "s3",
    displayName: "Native backup bucket",
    parameters: {
      endpoint: `https://127.0.0.1:${port}`,
      region: "us-east-1",
      bucket: "test-bucket",
      access_key_id: "fixture-public-key",
      prefix,
    },
    credentials: { secret_access_key: "fixture-private-signing-secret" },
  };
  const saved = await configureNativeS3(draft, transport);
  return {
    local,
    objects,
    requests,
    provider,
    action,
    transport,
    draft,
    saved,
    hold(method: string) {
      state.hold = method;
    },
    held: () => state.heldRow,
    deny(status: number) {
      state.denied = status;
    },
    corrupt() {
      state.corrupt = true;
    },
    async close() {
      provider.abort();
      action.abort();
      state.held?.destroy();
      const stopped = once(server, "close");
      const closed = [...sockets].map((socket) => once(socket, "close"));
      server.close();
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      expect(sockets.size).toBe(0);
      expect(state.errors).toEqual([]);
      rmSync(tls.directory, { recursive: true });
      await local.close();
    },
  };
}
