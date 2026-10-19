import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, vi } from "vitest";
import { z } from "zod";
import { configureNativeApiConnector } from "./native-api-connectors.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { tlsFetch } from "./native-s3-backup.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
export const bitbucketBackupToken =
  "fixture-bitbucket-key-independent-wire-oracle";
export const bitbucketBackupTarget = {
  owner: "owned-workspace",
  repo: "sealed-vault",
  branch: "backup/encrypted",
};
const base = "/2.0/repositories/owned-workspace/sealed-vault";
type Blob = { bytes: Buffer; lastCommit: string };
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
  received: { path: string; status: number }[];
  errors: Error[];
  deny: number;
  writeDeny: number;
  hold: string;
  holdPath: string;
  held?: Exchange;
  heldResponse?: ServerResponse;
  corrupt: string;
  race: boolean;
  afterWriteRace: boolean;
};
function commit(state: State) {
  state.head = createHash("sha1")
    .update(`commit-${state.snapshots.size}`)
    .digest("hex");
  state.snapshots.set(state.head, new Map(state.files));
}
function reply(response: ServerResponse, body: BoundaryValue, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function readContent(state: State, url: URL, response: ServerResponse) {
  const selected = url.pathname.slice(`${base}/src/`.length);
  const slash = selected.indexOf("/");
  const revision = selected.slice(0, slash);
  const id = decodeURIComponent(selected.slice(slash + 1));
  const stored = state.snapshots.get(revision)?.get(id);
  if (!stored) return reply(response, {}, 404);
  if (url.searchParams.get("format") === "meta") {
    return reply(response, {
      type: "commit_file",
      path: state.corrupt === "path" ? "foreign.json" : id,
      size: stored.bytes.length + (state.corrupt === "size" ? 1 : 0),
      attributes: state.corrupt === "link" ? ["link"] : [],
      commit: { hash: stored.lastCommit },
    });
  }
  response.writeHead(200, { "content-type": "application/json" });
  if (state.corrupt === "ciphertext")
    return response.end(JSON.stringify({ plaintext: true }));
  if (state.corrupt === "large")
    return response.end(JSON.stringify("A".repeat(1024 * 1024)));
  response.end(stored.bytes);
}
function writeContent(
  state: State,
  url: URL,
  body: string,
  response: ServerResponse,
) {
  expect(url.searchParams.get("branch")).toBe(bitbucketBackupTarget.branch);
  expect(url.searchParams.get("message")).toBe(
    "Back up encrypted OpenSesame vault",
  );
  const parent = url.searchParams.get("parents");
  const fields = [...new URLSearchParams(body)];
  expect(fields).toHaveLength(1);
  const [field, text] = fields[0] ?? [];
  if (!field || text === undefined || !field.startsWith("/backups/"))
    throw new Error("Invalid Source API upload");
  const id = field.slice(1);
  if (state.race) {
    state.race = false;
    commit(state);
  }
  if (parent !== state.head)
    return reply(response, { error: { message: bitbucketBackupToken } }, 409);
  const bytes = Buffer.from(text);
  expect(JSON.parse(text).format).toBe("opensesame-offline-backup");
  commit(state);
  const written = state.head;
  state.files.set(id, { bytes, lastCommit: written });
  state.snapshots.set(written, new Map(state.files));
  if (state.afterWriteRace) {
    commit(state);
    state.files.set(id, {
      bytes: Buffer.from(text.replace('"format"', '"wrong_format"')),
      lastCommit: state.head,
    });
    state.snapshots.set(state.head, new Map(state.files));
  }
  return reply(
    response,
    {
      type: "commit",
      hash: state.corrupt === "write" ? "not-a-commit" : written,
      parents: [
        { hash: state.corrupt === "parents" ? "f".repeat(40) : parent },
      ],
      repository: { full_name: "owned-workspace/sealed-vault" },
    },
    201,
  );
}
function providerResource(
  state: State,
  url: URL,
  response: ServerResponse,
): boolean {
  if (url.pathname === "/2.0/user") {
    reply(response, {
      type: "user",
      uuid: state.corrupt === "account" ? "{foreign-user}" : "{owned-user}",
      display_name: "Owned user",
    });
    return true;
  }
  if (url.pathname === base) {
    reply(response, {
      type: "repository",
      uuid: "{owned-repository}",
      full_name:
        state.corrupt === "project"
          ? "foreign/repo"
          : "owned-workspace/sealed-vault",
      scm: "git",
    });
    return true;
  }
  if (url.pathname === `${base}/refs/branches/backup%2Fencrypted`) {
    reply(response, {
      type: "branch",
      name: state.corrupt === "ref" ? "foreign" : bitbucketBackupTarget.branch,
      target: { hash: state.head },
    });
    return true;
  }
  return false;
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
  const url = new URL(row.url, "https://api.bitbucket.org");
  expect(request.headers.authorization).toBe(`Bearer ${bitbucketBackupToken}`);
  expect(request.headers["private-token"]).toBeUndefined();
  if (state.writeDeny && row.method !== "GET")
    return reply(response, { message: bitbucketBackupToken }, state.writeDeny);
  if (state.deny)
    return reply(response, { message: bitbucketBackupToken }, state.deny);
  if (state.hold === row.method && url.pathname.includes(state.holdPath)) {
    state.held = row;
    state.heldResponse = response;
    response.writeHead(row.method === "POST" ? 201 : 200, {
      "content-type": "application/json",
    });
    response.flushHeaders();
    response.write("{");
    return;
  }
  if (providerResource(state, url, response)) return;
  if (row.method === "GET" && url.pathname.startsWith(`${base}/src/`))
    return readContent(state, url, response);
  if (row.method === "POST" && url.pathname === `${base}/src`)
    return writeContent(state, url, row.body, response);
  return reply(response, {}, 405);
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-bitbucket-backup-"));
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
    cert: readFileSync(join(directory, "cert.pem")),
    key: readFileSync(join(directory, "key.pem")),
  };
}
function backupDraft() {
  return {
    providerId: "bitbucket",
    displayName: "Bitbucket encrypted backup",
    parameters: {
      backup_owner: bitbucketBackupTarget.owner,
      backup_repo: bitbucketBackupTarget.repo,
      backup_branch: bitbucketBackupTarget.branch,
    },
    credentials: { api_key: bitbucketBackupToken },
  };
}
export async function nativeBitbucketBackupFixture() {
  const local = await runtimeFixture();
  const { directory, cert, key } = certificate();
  const state: State = {
    files: new Map(),
    snapshots: new Map(),
    head: "",
    requests: [],
    received: [],
    errors: [],
    deny: 0,
    writeDeny: 0,
    hold: "",
    holdPath: "/src",
    corrupt: "",
    race: false,
    afterWriteRace: false,
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
    supportsNativeOrigin: (origin) => origin === "https://api.bitbucket.org",
    fetch: (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.bitbucket.org");
      expect(init).toMatchObject({
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        mode: "cors",
      });
      url.hostname = "127.0.0.1";
      url.port = String(port);
      return send(url, init).then((response) => {
        state.received.push({
          path: url.pathname + url.search,
          status: response.status,
        });
        return response;
      });
    },
  };
  const browserFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Uncaptured browser Fetch forbidden"));
  const draft = backupDraft();
  const saved = await configureNativeApiConnector(draft, transport);
  return {
    local,
    state,
    transport,
    provider,
    action,
    saved,
    draft,
    browserFetch,
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
      expect(browserFetch).not.toHaveBeenCalled();
      rmSync(directory, { recursive: true });
      await local.close();
    },
  };
}
