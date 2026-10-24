/**
 * Test-only loopback fixture for the owned S3 response client.
 *
 * Under `test/` deliberately: it types the accepted socket with `node:net`,
 * and `scripts/mtls/mtls-static-imports.mjs` (AT-STATIC-IMPORTS) treats
 * everything else under `src/` as a shipped source that may not import a
 * native module. Nothing the browser loads imports this file.
 */

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Effect, Redacted } from "effect";
import { z } from "zod";
import { makeS3SecretFiles } from "../s3.js";
import type { S3FilesConfig } from "../s3.js";

export function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const data = (value: string) => new TextEncoder().encode(value);
export const TEST_KEY = "TEST_ONLY_S3_RESPONSE_CREDENTIAL";

export type Plan = {
  status?: number;
  chunks?: readonly Uint8Array[];
  declared?: string;
  beforeNext?: ReturnType<typeof gate<void>>;
  hold?: ReturnType<typeof gate<void>>;
  truncate?: boolean;
  etag?: string;
  finished?: () => void;
};

export type Row = {
  method: string;
  path: string;
  match: string | undefined;
  none: string | undefined;
  body: Uint8Array;
  sent: number;
  finished: boolean;
  premature: boolean;
  written: ReturnType<typeof gate<void>>;
  closed: ReturnType<typeof gate<void>>;
  socketClosed: ReturnType<typeof gate<void>>;
};

async function requestBody(
  request: AsyncIterable<Buffer>,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new Error("owned fixture request exceeds bound");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function track(row: Row, response: ServerResponse, socket: Socket): void {
  response.on("finish", () => {
    row.finished = true;
  });
  response.on("close", () => {
    row.premature = !response.writableEnded;
    row.closed.resolve();
  });
  socket.on("close", () => row.socketClosed.resolve());
}

async function send(
  row: Row,
  response: ServerResponse,
  plan: Plan,
): Promise<void> {
  const headers = new Headers({ connection: "close" });
  if (plan.declared !== undefined) headers.set("content-length", plan.declared);
  if (plan.etag !== undefined) headers.set("etag", plan.etag);
  response.writeHead(plan.status ?? 200, Object.fromEntries(headers));
  response.flushHeaders();
  const chunks = plan.chunks ?? [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0 && plan.beforeNext) {
      await Promise.race([plan.beforeNext.promise, row.closed.promise]);
    }
    if (response.destroyed) return;
    const chunk = chunks[index];
    if (chunk === undefined) throw new Error("owned fixture chunk absent");
    await new Promise<void>((resolve) =>
      response.write(chunk, () => resolve()),
    );
    row.sent += chunk.byteLength;
    row.written.resolve();
  }
  if (chunks.length === 0) row.written.resolve();
  if (plan.hold) await Promise.race([plan.hold.promise, row.closed.promise]);
  if (response.destroyed) return;
  if (plan.truncate) response.destroy();
  else {
    response.end();
    plan.finished?.();
  }
}

export async function bucket(
  answer: readonly Plan[] | { respond: (row: Row) => Plan },
) {
  const rows: Row[] = [];
  const sockets = new Set<Socket>();
  const socketEndings: Array<Promise<void>> = [];
  const errors: string[] = [];
  const queued: Row[] = [];
  const waiting: Array<(row: Row) => void> = [];
  const server = createServer(async (request, response) => {
    const row: Row = {
      method: request.method ?? "",
      path: request.url ?? "",
      match: request.headers["if-match"],
      none: request.headers["if-none-match"],
      body: new Uint8Array(),
      sent: 0,
      finished: false,
      premature: false,
      written: gate(),
      closed: gate(),
      socketClosed: gate(),
    };
    rows.push(row);
    track(row, response, request.socket);
    try {
      row.body = await requestBody(request);
      const plan =
        "respond" in answer ? answer.respond(row) : answer[rows.length - 1];
      if (!plan) throw new Error("unexpected owned fixture request");
      const waitingRow = waiting.shift();
      if (waitingRow) waitingRow(row);
      else queued.push(row);
      await send(row, response, plan);
    } catch (error) {
      errors.push(
        error instanceof Error ? error.name : "owned fixture request failed",
      );
      response.destroy();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socketEndings.push(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(server.address());
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    rows,
    errors,
    files: (config: Partial<S3FilesConfig> = {}) =>
      makeS3SecretFiles({
        endpoint,
        region: "test-region",
        bucket: "vault-bucket",
        maxBytes: 64,
        credentials: {
          accessKeyId: "TEST_ONLY_KEY",
          secretAccessKey: Redacted.make(TEST_KEY),
        },
        ...config,
      }),
    next: () =>
      new Promise<Row>((resolve) => {
        const row = queued.shift();
        if (row) resolve(row);
        else waiting.push(resolve);
      }),
    close: async () => {
      const active = rows.filter((row) => !row.finished && !row.premature);
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeIdleConnections();
      if (active.length) for (const socket of sockets) socket.destroy();
      await closed;
      // Undici may open a replacement idle connection after an aborted request.
      // Await every owned TCP close event, not just sockets with a request row.
      await Promise.all(socketEndings);
      await Promise.all(rows.map((row) => row.socketClosed.promise));
      if (active.length || errors.length || server.listening || sockets.size) {
        throw new Error(
          `owned fixture did not close normally: active=${active.length}, errors=${errors.join(",")}, sockets=${sockets.size}`,
        );
      }
    },
  };
}

export async function failure<A, E>(
  operation: Effect.Effect<A, E>,
): Promise<E> {
  const result = await Effect.runPromise(Effect.flip(operation));
  return result;
}
