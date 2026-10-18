import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Server, type ServerResponse, createServer } from "node:http";
import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import type { BitwardenCborMap } from "./bitwarden-native-cose.js";
import {
  NATIVE_EMAIL,
  NATIVE_KEY_ID,
  NATIVE_USER,
  nativeFixtureUnlock,
  nativeProviderPlaintext,
} from "./bitwarden-native-crypto.test-support.js";
import { nativeObject, nativeText } from "./bitwarden-native-item.js";
import type { SecretBackendTransport } from "./transport.js";
export {
  NATIVE_EMAIL,
  NATIVE_LIMITS,
  NATIVE_PASSWORD,
  NATIVE_USER,
  nativeProviderPlaintext,
} from "./bitwarden-native-crypto.test-support.js";

type HeldRequest = {
  path: string;
  method: string;
  arrived(): void;
  wait: Promise<void>;
  release(): void;
};
type NativeFixtureState = {
  rejectWrites: boolean;
  wrongId: boolean;
  corruptReply: boolean;
  emptyTrash200: boolean;
  held?: HeldRequest;
  extraCiphers: JsonObject[];
};
type RequestRecord = { method: string; path: string; body: string };
type FixtureOwner = {
  modern: boolean;
  unlock: ReturnType<typeof nativeFixtureUnlock>;
  items: Map<string, JsonObject>;
  decoded: Map<string, BitwardenCborMap>;
  requests: RequestRecord[];
  state: NativeFixtureState;
  revised(): string;
};
function identity(
  owner: FixtureOwner,
  path: string,
  text: string,
  response: ServerResponse,
): boolean {
  if (path === "/identity/accounts/prelogin/password") {
    response.end(
      JSON.stringify({ kdfSettings: owner.unlock.kdf, salt: NATIVE_EMAIL }),
    );
    return true;
  }
  if (path !== "/identity/connect/token") return false;
  const form = new URLSearchParams(text);
  assert.equal(form.get("client_id"), `user.${NATIVE_USER}`);
  assert.equal(form.get("client_secret"), "owned-native-client-secret");
  assert.equal(form.get("scope"), "api");
  response.end(
    JSON.stringify({
      access_token: "owned.native-token",
      token_type: "Bearer",
      expires_in: 60,
      userDecryptionOptions: {
        hasMasterPassword: true,
        masterPasswordUnlock: owner.unlock,
      },
    }),
  );
  return true;
}
function createCipher(
  owner: FixtureOwner,
  text: string,
  response: ServerResponse,
): void {
  const body = nativeObject(JSON.parse(text));
  assert.equal(body.encryptedFor, NATIVE_USER);
  assert.equal(body.organizationId, null);
  if (owner.modern) assert.equal(body.encryptedByKeyId, NATIVE_KEY_ID);
  const plain = nativeProviderPlaintext(body);
  const id = randomUUID();
  const row = { ...body, id, revisionDate: owner.revised(), edit: true };
  owner.items.set(id, row);
  owner.decoded.set(id, plain);
  response.end(
    JSON.stringify(owner.state.wrongId ? { ...row, id: "wrong" } : row),
  );
  return;
}
function cipher(
  owner: FixtureOwner,
  path: string,
  method: string,
  text: string,
  response: ServerResponse,
): void {
  const { items, decoded, state } = owner;
  if (state.rejectWrites && method !== "GET") {
    response.writeHead(401).end("{}");
    return;
  }
  if (path === "/api/ciphers" && method === "POST") {
    createCipher(owner, text, response);
    return;
  }
  const match = /^\/api\/ciphers\/([0-9a-f-]+)(\/delete)?$/.exec(path);
  if (!match) {
    response.writeHead(404).end("{}");
    return;
  }
  const id = nativeText(match[1]);
  const row = items.get(id);
  if (!row) {
    response.writeHead(404).end("{}");
    return;
  }
  if (method === "GET") {
    response.end(
      JSON.stringify(state.wrongId ? { ...row, id: randomUUID() } : row),
    );
    return;
  }
  if (method === "PUT" && match?.[2]) {
    row.deletedDate = owner.revised();
    response.writeHead(state.emptyTrash200 ? 200 : 204).end();
    return;
  }
  if (method === "PUT") {
    const body = nativeObject(JSON.parse(text));
    assert.equal(body.id, id);
    assert.equal(body.lastKnownRevisionDate, row.revisionDate);
    assert.equal(body.key, row.key);
    assert.equal(body.encryptedFor, NATIVE_USER);
    const plain = nativeProviderPlaintext(body);
    const next = { ...body, revisionDate: owner.revised() };
    items.set(id, next);
    decoded.set(id, plain);
    response.end(
      JSON.stringify(
        state.corruptReply ? { ...next, data: "corrupted reply" } : next,
      ),
    );
    return;
  }
  response.writeHead(405).end("{}");
}
export async function nativeHttpFixture(modern: boolean) {
  let revision = 0;
  const owner: FixtureOwner = {
    modern,
    unlock: nativeFixtureUnlock(modern),
    items: new Map(),
    decoded: new Map(),
    requests: [],
    state: {
      rejectWrites: false,
      wrongId: false,
      corruptReply: false,
      emptyTrash200: false,
      extraCiphers: [],
    },
    revised: () =>
      new Date(Date.UTC(2026, 9, 1, 0, 0, ++revision)).toISOString(),
  };
  const server = createServer(async (incoming, response) => {
    response.setHeader(
      "access-control-allow-origin",
      incoming.headers.origin ?? "*",
    );
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "authorization,content-type",
    );
    if (incoming.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    let text = "";
    for await (const chunk of incoming) text += chunk.toString();
    const path = incoming.url ?? "";
    const method = incoming.method ?? "GET";
    owner.requests.push({ path, method, body: text });
    response.setHeader("content-type", "application/json");
    try {
      const held = owner.state.held;
      if (held?.path === path && held.method === method) {
        held.arrived();
        await held.wait;
      }
      if (identity(owner, path, text, response)) return;
      assert.equal(incoming.headers.authorization, "Bearer owned.native-token");
      if (path === "/api/sync?excludeDomains=true") {
        response.end(
          JSON.stringify({
            profile: { id: NATIVE_USER, email: NATIVE_EMAIL },
            userDecryption: { masterPasswordUnlock: owner.unlock },
            ciphers: [...owner.items.values(), ...owner.state.extraCiphers],
          }),
        );
        return;
      }
      cipher(owner, path, method, text, response);
    } catch {
      response
        .writeHead(400)
        .end('{"error":"owned fixture validation failed"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const base = `http://127.0.0.1:${address.port}/`;
  const controller = new AbortController();
  const transport: SecretBackendTransport = {
    fetch: globalThis.fetch,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  return {
    ...owner,
    transport,
    controller,
    credentials: {
      baseUrl: `${base}api`,
      identityUrl: `${base}identity`,
      email: NATIVE_EMAIL,
      clientId: `user.${NATIVE_USER}`,
      clientSecret: "owned-native-client-secret",
      deviceIdentifier: randomUUID(),
    },
    hold: (path: string, method: string) => holdRequest(owner, path, method),
    close: () => closeFixture(owner, controller, server),
  };
}

function holdRequest(owner: FixtureOwner, path: string, method: string) {
  let arrived!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  owner.state.held = { path, method, arrived, wait, release };
  return { ready, release };
}
async function closeFixture(
  owner: FixtureOwner,
  controller: AbortController,
  server: Server,
): Promise<void> {
  owner.state.held?.release();
  controller.abort();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
