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
export const gitlabBackupToken = "fixture-gitlab-key-independent-wire-oracle";
export const gitlabBackupTarget = {
  project: "owned-group/sealed-vault",
  branch: "backup/encrypted",
};
const base = "/api/v4/projects/owned-group%2Fsealed-vault";
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
  const id = decodeURIComponent(
    url.pathname.slice(`${base}/repository/files/`.length),
  );
  const revision = url.searchParams.get("ref") ?? "";
  const stored = state.snapshots.get(revision)?.get(id);
  if (!stored) return reply(response, {}, 404);
  const content = {
    file_path: id,
    encoding: "base64",
    size: stored.bytes.length,
    content: stored.bytes.toString("base64"),
    content_sha256: createHash("sha256").update(stored.bytes).digest("hex"),
    commit_id: revision,
    last_commit_id: stored.lastCommit,
  };
  if (state.corrupt === "digest") content.content_sha256 = "f".repeat(64);
  if (state.corrupt === "path") content.file_path = "foreign.json";
  if (state.corrupt === "encoding") content.encoding = "none";
  if (state.corrupt === "size") content.size++;
  if (state.corrupt === "ciphertext")
    content.content = Buffer.from("plaintext").toString("base64");
  if (state.corrupt === "large") content.content = "A".repeat(1024 * 1024);
  if (state.corrupt === "commit") content.commit_id = "f".repeat(40);
  if (state.corrupt === "last") content.last_commit_id = "not-a-commit";
  return reply(response, content);
}
const payload = z
  .object({
    commit_message: z.literal("Back up encrypted OpenSesame vault"),
    branch: z.literal("backup/encrypted"),
    encoding: z.literal("base64"),
    content: z.string(),
    last_commit_id: z.string().optional(),
  })
  .strict();
function writeContent(
  state: State,
  url: URL,
  body: string,
  response: ServerResponse,
  method: string,
) {
  const input = payload.parse(JSON.parse(body));
  const id = decodeURIComponent(
    url.pathname.slice(`${base}/repository/files/`.length),
  );
  let prior = state.files.get(id);
  expect(method).toBe(input.last_commit_id === undefined ? "POST" : "PUT");
  if (state.race) {
    state.race = false;
    if (!prior) throw new Error("Missing CAS source");
    commit(state);
    prior = { ...prior, lastCommit: state.head };
    state.files.set(id, prior);
    state.snapshots.set(state.head, new Map(state.files));
  }
  if (
    prior
      ? input.last_commit_id !== prior.lastCommit
      : input.last_commit_id !== undefined
  )
    return reply(response, { message: gitlabBackupToken }, 400);
  const bytes = Buffer.from(input.content, "base64");
  expect(bytes.toString("base64")).toBe(input.content);
  expect(JSON.parse(bytes.toString()).format).toBe("opensesame-offline-backup");
  commit(state);
  state.files.set(id, { bytes, lastCommit: state.head });
  state.snapshots.set(state.head, new Map(state.files));
  if (state.afterWriteRace) {
    commit(state);
    state.files.set(id, {
      bytes: Buffer.from(
        bytes.toString().replace('"format"', '"wrong_format"'),
      ),
      lastCommit: state.head,
    });
    state.snapshots.set(state.head, new Map(state.files));
  }
  return reply(
    response,
    {
      file_path: state.corrupt === "write" ? "foreign.json" : id,
      branch: gitlabBackupTarget.branch,
    },
    prior ? 200 : 201,
  );
}
function providerResource(
  state: State,
  url: URL,
  response: ServerResponse,
): boolean {
  if (url.pathname === "/api/v4/user") {
    reply(response, {
      id: 12345,
      username: state.corrupt === "account" ? "foreign-user" : "owned-user",
    });
    return true;
  }
  if (url.pathname === "/api/v4/projects") {
    reply(response, [{ id: 842, name: "Sealed vault" }]);
    return true;
  }
  if (url.pathname === base) {
    reply(response, {
      id: 842,
      path_with_namespace:
        state.corrupt === "project"
          ? "foreign/repo"
          : gitlabBackupTarget.project,
      archived: state.corrupt === "archived",
      repository_access_level:
        state.corrupt === "reflection" ? gitlabBackupToken : "enabled",
    });
    return true;
  }
  if (url.pathname === `${base}/repository/branches/backup%2Fencrypted`) {
    reply(response, {
      name: state.corrupt === "ref" ? "foreign" : gitlabBackupTarget.branch,
      can_push: state.corrupt !== "readonly",
      commit: { id: state.head },
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
  const url = new URL(row.url, "https://gitlab.com");
  expect(request.headers.authorization).toBe(`Bearer ${gitlabBackupToken}`);
  expect(request.headers["private-token"]).toBeUndefined();
  if (state.writeDeny && row.method !== "GET")
    return reply(response, { message: gitlabBackupToken }, state.writeDeny);
  if (state.deny)
    return reply(response, { message: gitlabBackupToken }, state.deny);
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
  if (!url.pathname.startsWith(`${base}/repository/files/`))
    return reply(response, {}, 404);
  if (row.method === "GET") return readContent(state, url, response);
  if (["POST", "PUT"].includes(row.method))
    return writeContent(state, url, row.body, response, row.method);
  return reply(response, {}, 405);
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-gitlab-backup-"));
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
export async function nativeGitlabBackupFixture() {
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
    holdPath: "/repository/files/",
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
    supportsNativeOrigin: (origin) => origin === "https://gitlab.com",
    fetch: (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://gitlab.com");
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
  const draft = {
    providerId: "gitlab",
    displayName: "GitLab encrypted backup",
    parameters: {
      backup_project: gitlabBackupTarget.project,
      backup_branch: gitlabBackupTarget.branch,
    },
    credentials: { api_key: gitlabBackupToken },
  };
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
