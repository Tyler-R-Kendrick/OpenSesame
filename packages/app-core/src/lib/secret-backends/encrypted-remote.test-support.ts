import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { expect } from "vitest";
import { z } from "zod";
import { kvFlush, kvForgetAll } from "../kv.js";
import { tlsFetch } from "../test/native-s3-backup-fixtures.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import {
  type EncryptedRemoteStore,
  remoteStore,
} from "./encrypted-remote-codec.js";
import { localVaultSessionGuard } from "./local-vault-port.js";
import { deferred, runtimeFixture } from "./runtime.test-support.js";
import type { SecretBackendTransport } from "./transport.js";
export const STORE_ID = "12345678-1234-4234-9234-123456789abc";
export const ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
export const BEARER_TOKEN = "operator-object-endpoint-token";
export const ITEM_ID = "22345678-1234-4234-9234-123456789abc";
const FORMAT = "opensesame.encrypted-remote";
export function independentSeal(
  store: EncryptedRemoteStore,
  objectUrl: string,
  key = ENCRYPTION_KEY,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    nonce,
  );
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([FORMAT, 1, objectUrl, store.storeId, store.revision]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(store)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    storeId: store.storeId,
    revision: store.revision,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}
export function independentOpen(
  serialized: string,
  objectUrl: string,
  key = ENCRYPTION_KEY,
): EncryptedRemoteStore {
  const envelope = z
    .object({
      storeId: z.string(),
      revision: z.number(),
      nonce: z.string(),
      ciphertext: z.string(),
    })
    .parse(JSON.parse(serialized));
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64"),
    Buffer.from(envelope.nonce, "base64"),
  );
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        FORMAT,
        1,
        objectUrl,
        envelope.storeId,
        envelope.revision,
      ]),
    ),
  );
  cipher.setAuthTag(bytes.subarray(-16));
  return remoteStore(
    JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(0, -16)),
        cipher.final(),
      ]).toString(),
    ),
  );
}
export function initialStore(revision = 1): EncryptedRemoteStore {
  return {
    version: 1,
    storeId: STORE_ID,
    revision,
    items: [
      {
        id: ITEM_ID,
        name: "Independent fixture note",
        kind: "note",
        notes: "Independently encrypted original note",
        secret: "",
      },
    ],
  };
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "encrypted-remote-"));
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

type Exchange = {
  method: string;
  path: string;
  authorization: string;
  match: string;
  noneMatch: string;
  body: string;
};
function fixtureState() {
  return {
    bytes: "",
    etag: '"0"',
    missing: false,
    weak: false,
    omitEtag: false,
    hold: false,
    holdBody: false,
    conflict: false,
    redirect: false,
    unauthorized: false,
    revision: 1,
    holdPut: false,
    putCount: 0,
  };
}

type State = ReturnType<typeof fixtureState>;
async function putObject(
  response: ServerResponse,
  state: State,
  row: Exchange,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
) {
  if (state.holdPut) {
    state.putCount++;
    if (state.putCount === 2) entered.resolve();
    await release.promise;
  }
  if (
    (row.noneMatch === "*" && !state.missing) ||
    (row.noneMatch !== "*" && (state.missing || row.match !== state.etag)) ||
    state.conflict
  ) {
    response.writeHead(412);
    response.end();
    return;
  }
  state.bytes = row.body;
  state.missing = false;
  state.etag = `"${createHash("sha256").update(row.body).digest("hex")}"`;
  response.writeHead(200);
  response.end();
  return;
}
async function getObject(
  response: ServerResponse,
  state: State,
  row: Exchange,
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
) {
  if (row.method !== "GET") {
    response.writeHead(405);
    response.end();
    return;
  }
  if (state.missing) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (!state.omitEtag)
    response.setHeader("ETag", `${state.weak ? "W/" : ""}${state.etag}`);
  response.setHeader("Content-Type", "application/json");
  if (state.holdBody) {
    response.writeHead(200);
    response.write(state.bytes.slice(0, 10));
    entered.resolve();
    await release.promise;
    response.end(state.bytes.slice(10));
    return;
  }
  response.end(state.bytes);
}
async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  state: State,
  requests: Exchange[],
  entered: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const row = {
    method: request.method ?? "",
    path: request.url ?? "",
    authorization: request.headers.authorization ?? "",
    match: String(request.headers["if-match"] ?? ""),
    noneMatch: String(request.headers["if-none-match"] ?? ""),
    body,
  };
  requests.push(row);
  if (
    row.path !== "/objects/vault.json" ||
    state.unauthorized ||
    row.authorization !== `Bearer ${BEARER_TOKEN}`
  ) {
    response.writeHead(401);
    response.end();
    return;
  }
  if (state.redirect) {
    response.writeHead(302, { Location: "/other.json" });
    response.end();
    return;
  }
  if (state.hold) {
    entered.resolve();
    await release.promise;
  }
  if (row.method === "PUT")
    return putObject(response, state, row, entered, release);
  return getObject(response, state, row, entered, release);
}
export async function encryptedRemoteFixture() {
  const local = await runtimeFixture();
  const tls = certificate();
  const entered = deferred<void>();
  const release = deferred<void>();
  const requests: Exchange[] = [];
  const state = fixtureState();
  const errors: Error[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer(tls, (request, response) => {
    void receive(request, response, state, requests, entered, release).catch(
      (error: Error) => {
        errors.push(error);
        response.destroy();
      },
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z.object({ port: z.number() }).parse(server.address());
  const objectUrl = `https://127.0.0.1:${address.port}/objects/vault.json`;
  state.bytes = independentSeal(initialStore(), objectUrl);
  const captures: (() => void)[] = [];
  const capture = () => {
    const owner = localVaultSessionGuard(vaultStore);
    const lifetime = new AbortController();
    const unsubscribe = vaultStore.onLock(() => lifetime.abort());
    captures.push(() => {
      lifetime.abort();
      unsubscribe();
      owner.close();
    });
    const transport: SecretBackendTransport = {
      fetch: tlsFetch(tls.cert),
      signal: lifetime.signal,
      assertCurrent: () => {
        lifetime.signal.throwIfAborted();
        owner.current();
      },
    };
    return { transport, withdraw: () => lifetime.abort() };
  };
  const original = capture();
  return {
    state,
    files: local.files,
    requests,
    transport: original.transport,
    capture,
    entered,
    release,
    config: {
      objectUrl,
      storeId: STORE_ID,
      encryptionKey: ENCRYPTION_KEY,
      bearerToken: BEARER_TOKEN,
    },
    rotateTarget: original.withdraw,
    async close() {
      release.resolve();
      for (const close of captures) close();
      const stopped = once(server, "close");
      const closed = [...sockets].map((socket) => once(socket, "close"));
      server.close();
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      expect(sockets.size).toBe(0);
      expect(errors).toEqual([]);
      rmSync(tls.directory, { recursive: true, force: true });
      await local.close();
    },
  };
}

export async function freshLocalVault(files: Map<string, string>, pin: string) {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  files.clear();
  vaultStore.rehydrate();
  await vaultStore.createWithPin(pin);
}
