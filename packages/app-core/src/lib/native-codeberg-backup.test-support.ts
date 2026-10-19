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
import { expect, vi } from "vitest";
import { z } from "zod";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { oauthDraft } from "./native-oauth.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
import { tlsFetch } from "./test/native-s3-backup-fixtures.js";
export const codebergBackupToken = "codeberg-owned-backup-issued-secret";
export const codebergBackupTarget = {
  owner: "owned-user",
  repo: "sealed-vault",
  branch: "backup/encrypted",
};
const base = "/api/v1/repos/owned-user/sealed-vault";
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
  challenge: string;
  token: string;
  refresh: string;
  exchanges: number;
  refreshes: number;
  callback: string;
  received: { path: string; status: number }[];
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
  method: string,
) {
  const input = payload.parse(JSON.parse(body));
  const id = decodeURIComponent(url.pathname.slice(`${base}/contents/`.length));
  let prior = state.files.get(id);
  expect(method).toBe(input.sha === undefined ? "POST" : "PUT");
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
    {
      content: { type: "file", path: id, sha },
      commit: { sha: state.corrupt === "commit" ? "f".repeat(40) : state.head },
    },
    prior ? 200 : 201,
  );
}
const callback = "https://selfhost.example/auth/native-connector.html";
function tokenResponse(state: State, body: string, response: ServerResponse) {
  const form = new URLSearchParams(body);
  expect(form.has("client_secret")).toBe(false);
  expect(form.get("client_id")).toBe("public-browser-client");
  if (form.get("grant_type") === "authorization_code") {
    expect(form.get("code")).toBe("single-use-codeberg-code");
    expect(form.get("redirect_uri")).toBe(state.callback);
    expect(
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(state.challenge);
    expect(state.exchanges++).toBe(0);
    state.token = codebergBackupToken;
  } else {
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(state.refresh);
    state.refreshes++;
    state.token = `codeberg-rotated-access-${state.refreshes}`;
    state.refresh = `codeberg-rotated-refresh-${state.refreshes}`;
  }
  reply(response, {
    access_token: state.token,
    refresh_token: state.refresh,
    token_type: "Bearer",
    expires_in: 900,
  });
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
  const url = new URL(row.url, "https://codeberg.org");
  if (url.pathname === "/login/oauth/access_token")
    return tokenResponse(state, row.body, response);
  expect(request.headers.authorization).toBe(`Bearer ${state.token}`);
  expect(request.headers["x-github-api-version"]).toBeUndefined();
  if (state.deny)
    return reply(response, { message: codebergBackupToken }, state.deny);
  if (state.hold === row.method) {
    state.held = row;
    state.heldResponse = response;
    response.writeHead(row.method === "POST" ? 201 : 200, {
      "content-type": "application/json",
    });
    response.flushHeaders();
    response.write("{");
    return;
  }
  if (url.pathname === "/api/v1/user")
    return reply(response, {
      id: state.corrupt === "account" ? 54321 : 12345,
      login: "owned-user",
      full_name: "Owned Codeberg user",
    });
  if (url.pathname === `${base}/branches/backup%2Fencrypted`)
    return reply(response, {
      name: state.corrupt === "ref" ? "foreign" : "backup/encrypted",
      commit: { id: state.head },
    });
  if (!url.pathname.startsWith(`${base}/contents/`))
    return reply(response, {}, 404);
  if (row.method === "GET") return readContent(state, url, response);
  if (["POST", "PUT"].includes(row.method))
    return writeContent(state, url, row.body, response, row.method);
  return reply(response, {}, 405);
}
function certificate() {
  const directory = mkdtempSync(join(tmpdir(), "native-codeberg-backup-"));
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
function browserPort(state: State) {
  return bindNativeOAuthBrowserPort({
    redirectUri: state.callback,
    navigate: () => {
      throw new Error("Unexpected full-page navigation");
    },
    scrubCallback: () => {},
    authorize: async (href, options) => {
      const url = new URL(href);
      expect(url.origin).toBe("https://codeberg.org");
      expect(url.pathname).toBe("/login/oauth/authorize");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")).toBe("");
      state.challenge = url.searchParams.get("code_challenge") ?? "";
      return new URLSearchParams({
        native_state: options.state,
        native_code: "single-use-codeberg-code",
      }).toString();
    },
  });
}
type CodebergFixtureOptions = {
  authorize?: boolean;
  backupTarget?: boolean;
  redirectUri?: string;
};
function initialState(options: CodebergFixtureOptions): State {
  return {
    files: new Map(),
    snapshots: new Map(),
    head: "",
    requests: [],
    errors: [],
    deny: 0,
    hold: "",
    corrupt: "",
    race: false,
    challenge: "",
    token: "",
    refresh: "codeberg-issued-refresh",
    exchanges: 0,
    refreshes: 0,
    callback: options.redirectUri ?? callback,
    received: [],
  };
}
function backupDraft(options: CodebergFixtureOptions) {
  const draft = oauthDraft("codeberg");
  if (options.backupTarget !== false)
    draft.parameters = {
      ...draft.parameters,
      backup_owner: "owned-user",
      backup_repo: "sealed-vault",
      backup_branch: "backup/encrypted",
    };
  return draft;
}
export async function nativeCodebergBackupFixture(
  options: CodebergFixtureOptions = {},
) {
  const local = await runtimeFixture();
  const { directory, cert, key } = certificate();
  const state = initialState(options);
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
    supportsNativeOrigin: (origin) => origin === "https://codeberg.org",
    fetch: (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://codeberg.org");
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
  const draft = backupDraft(options);
  const browserRelease = browserPort(state);
  const browserFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Uncaptured browser Fetch forbidden"));
  const saved = await configureNativeBrowserOAuthConnector(draft, transport);
  if (options.authorize !== false)
    await beginNativeBrowserAuthorization(
      saved.connectionId,
      "user",
      transport,
    );
  return {
    local,
    state,
    transport,
    provider,
    action,
    saved,
    draft,
    browserFetch,
    bindConsent: () => browserPort(state),
    async close() {
      browserRelease();
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
