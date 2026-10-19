import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { BoundaryObject } from "@opensesame/os-domain";
import { expect } from "vitest";
import { z } from "zod";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { configureNativeGithubPersonal } from "./native-github-personal.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";

export const githubBackupToken = "github_pat_owned-backup-fixture-secret";
export const githubBackupTarget = {
  owner: "octocat",
  repo: "sealed-vault",
  branch: "backup/encrypted",
};
const base = "/repos/octocat/sealed-vault";
type Blob = { bytes: Buffer; sha: string };
type Exchange = {
  method: string;
  url: string;
  body: string;
  closed: boolean;
  premature: boolean;
};
type State = {
  files: Map<string, Blob>;
  snapshots: Map<string, Map<string, Blob>>;
  head: string;
  requests: Exchange[];
  errors: Error[];
  deny: number;
  hold: string;
  held?: Exchange;
  heldResponse?: ServerResponse;
  corrupt: string;
  race: boolean;
};
export function gitBlob(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function commit(state: State) {
  state.head = createHash("sha1")
    .update(`commit-${state.snapshots.size}`)
    .digest("hex");
  state.snapshots.set(state.head, new Map(state.files));
}
function reply(response: ServerResponse, body: BoundaryObject, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function readContent(state: State, url: URL, response: ServerResponse) {
  const id = decodeURIComponent(url.pathname.slice(`${base}/contents/`.length));
  const stored = state.snapshots
    .get(url.searchParams.get("ref") ?? "")
    ?.get(id);
  if (!stored) return reply(response, {}, 404);
  const content = {
    type: "file",
    path: id,
    sha: stored.sha,
    size: stored.bytes.length,
    encoding: "base64",
    content:
      stored.bytes
        .toString("base64")
        .match(/.{1,60}/g)
        ?.join("\n") ?? "",
  };
  if (state.corrupt === "sha") content.sha = "f".repeat(40);
  if (state.corrupt === "path") content.path = "foreign.json";
  if (state.corrupt === "encoding") content.encoding = "none";
  if (state.corrupt === "size") content.size += 1;
  if (state.corrupt === "ciphertext")
    content.content = Buffer.from("plaintext").toString("base64");
  if (state.corrupt === "large") content.content = "A".repeat(1024 * 1024);
  return reply(response, content);
}
const payload = z
  .object({
    message: z.literal("Back up encrypted OpenSesame vault"),
    branch: z.literal("backup/encrypted"),
    content: z.string(),
    sha: z.string().optional(),
  })
  .strict();
function writeContent(
  state: State,
  url: URL,
  body: string,
  response: ServerResponse,
) {
  const input = payload.parse(JSON.parse(body));
  const id = decodeURIComponent(url.pathname.slice(`${base}/contents/`.length));
  let prior = state.files.get(id);
  if (state.race) {
    state.race = false;
    if (!prior) throw new Error("CAS race needs an existing encrypted blob");
    const bytes = Buffer.concat([prior.bytes, Buffer.from("\n")]);
    prior = { bytes, sha: gitBlob(bytes) };
    state.files.set(id, prior);
    commit(state);
  }
  if (prior ? input.sha !== prior.sha : input.sha !== undefined)
    return reply(response, {}, prior && input.sha ? 409 : 422);
  const bytes = Buffer.from(input.content, "base64");
  const sha = gitBlob(bytes);
  expect(bytes.toString("base64")).toBe(input.content);
  expect(JSON.parse(bytes.toString()).format).toBe("opensesame-offline-backup");
  state.files.set(id, { bytes, sha });
  commit(state);
  if (state.corrupt === "write")
    return reply(response, { content: { type: "file", path: id, sha } }, 201);
  return reply(
    response,
    { content: { type: "file", path: id, sha }, commit: { sha: state.head } },
    prior ? 200 : 201,
  );
}
async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  state: State,
) {
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(Buffer.from(part));
  const row: Exchange = {
    method: request.method ?? "GET",
    url: request.url ?? "/",
    body: Buffer.concat(chunks).toString(),
    closed: false,
    premature: false,
  };
  state.requests.push(row);
  response.once("close", () => {
    row.closed = true;
    row.premature = !response.writableEnded;
  });
  expect(request.headers.authorization).toBe(`Bearer ${githubBackupToken}`);
  expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
  const url = new URL(row.url, "https://api.github.com");
  if (url.pathname === "/user")
    return reply(response, { id: 12345, login: "octocat", type: "User" });
  if (state.deny)
    return reply(response, { message: githubBackupToken }, state.deny);
  if (state.hold === row.method) {
    state.held = row;
    state.heldResponse = response;
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    response.write("{");
    return;
  }
  if (url.pathname === `${base}/git/ref/heads/backup/encrypted`)
    return reply(response, {
      ref:
        state.corrupt === "ref"
          ? "refs/heads/foreign"
          : "refs/heads/backup/encrypted",
      object: { type: "commit", sha: state.head },
    });
  if (!url.pathname.startsWith(`${base}/contents/`))
    return reply(response, {}, 404);
  if (row.method === "GET") return readContent(state, url, response);
  if (row.method === "PUT") return writeContent(state, url, row.body, response);
  return reply(response, {}, 405);
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-github-backup-"));
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
  const cert = readFileSync(join(directory, "cert.pem"));
  return { directory, cert, key: readFileSync(join(directory, "key.pem")) };
}
export async function nativeGithubBackupFixture() {
  const local = await runtimeFixture();
  const { directory, cert, key } = certificate();
  const state: State = {
    files: new Map(),
    snapshots: new Map(),
    head: "",
    requests: [],
    errors: [],
    deny: 0,
    hold: "",
    corrupt: "",
    race: false,
  };
  commit(state);
  const server = createServer({ key, cert }, (request, response) => {
    void receive(request, response, state).catch((error: Error) => {
      state.errors.push(error);
      response.destroy();
    });
  });
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const send = tlsFetch(cert);
  const provider = new AbortController();
  const action = new AbortController();
  const transport: NativeProviderTransport = {
    signal: provider.signal,
    assertCurrent: () => provider.signal.throwIfAborted(),
    fetch: (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        mode: "cors",
      });
      url.hostname = "127.0.0.1";
      url.port = String(port);
      return send(url, init);
    },
  };
  const draft = {
    providerId: "github",
    displayName: "Native sealed backups",
    parameters: {},
    credentials: { api_key: githubBackupToken },
  };
  const saved = await configureNativeGithubPersonal(draft, transport);
  return {
    local,
    state,
    transport,
    provider,
    action,
    saved,
    draft,
    async close() {
      provider.abort();
      action.abort();
      state.heldResponse?.destroy();
      const stopped = once(server, "close");
      const closed = [...sockets].map((socket) => once(socket, "close"));
      server.close();
      server.closeAllConnections();
      await Promise.all([stopped, ...closed]);
      expect(sockets.size).toBe(0);
      expect(state.errors).toEqual([]);
      rmSync(directory, { recursive: true });
      await local.close();
    },
  };
}
