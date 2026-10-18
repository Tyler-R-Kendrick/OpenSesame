import { createCipheriv, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ProtonPassConfiguration } from "./proton-pass-protocol.js";
import { createProtonPassSessions } from "./proton-pass-session.js";
import { secretBackendSessionClosure } from "./sessions.js";
import type { SecretBackendTransport } from "./transport.js";
import { SecretBackendError } from "./types.js";

const patKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const serverToken = `pst_${"P".repeat(64)}`;
const combined = `${serverToken}::${Buffer.from(patKey).toString("base64url")}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function encrypted(plain: Uint8Array, key: Uint8Array, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([
    iv,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function shareKey(rotation: number): Uint8Array {
  return new Uint8Array(32).fill(rotation + 32);
}
function fixtureState() {
  return {
    role: "2",
    rotations: 2,
    repeated: false,
    unauthorized: false,
    holdKeys: false,
    expires: 0,
    code: 1000,
    targetType: 1,
  };
}
function reply(state: ReturnType<typeof fixtureState>, path: URL) {
  if (path.pathname.endsWith("/personal-access-token/session")) {
    return {
      status: 200,
      payload: {
        Code: state.code,
        Session: {
          SessionUID: "synthetic-session",
          AccessToken: "private-issued-token",
          RefreshToken: "private-unused-refresh",
          Scopes: ["pass"],
          AccessExpirationTime: state.expires || undefined,
        },
      },
    };
  }
  if (state.unauthorized) {
    return {
      status: 401,
      payload: { Code: 10013, Error: "private-provider-error" },
    };
  }
  if (path.pathname.endsWith("/share")) {
    const title = Buffer.from("Synthetic vault");
    return {
      status: 200,
      payload: {
        Code: 1000,
        Shares: [
          {
            ShareID: "PAT/share",
            VaultID: "original-vault",
            TargetID: "original-vault",
            TargetType: state.targetType,
            Owner: true,
            ShareRoleID: state.role,
            Permission: 0,
            GroupID: null,
            ContentFormatVersion: 1,
            ContentKeyRotation: state.rotations - 1,
            Content: encrypted(
              Buffer.concat([Buffer.from([10, title.length]), title]),
              shareKey(state.rotations - 1),
              "vaultcontent",
            ),
          },
        ],
      },
    };
  }
  if (path.pathname.endsWith("/key")) {
    const page = Number(path.searchParams.get("Page"));
    const keys = Array.from({ length: state.rotations }, (_, rotation) => ({
      KeyRotation: state.repeated ? 0 : rotation,
      CreateTime: 1720000000,
      Key: encrypted(shareKey(rotation), patKey, "sharekey"),
    })).slice(page * 100, (page + 1) * 100);
    return {
      status: 200,
      payload: {
        Code: 1000,
        ShareKeys: { Total: state.rotations, Keys: keys },
      },
    };
  }
  return {
    status: 200,
    payload: { Code: 1000, Items: { RevisionsData: [], LastToken: null } },
  };
}
async function fixture() {
  const controller = new AbortController();
  const requests: {
    path: string;
    headers: IncomingMessage["headers"];
    body: string;
  }[] = [];
  const hold = deferred();
  const entered = deferred();
  const state = fixtureState();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = new URL(req.url ?? "/", "http://localhost");
    requests.push({
      path: path.pathname + path.search,
      headers: { ...req.headers },
      body: Buffer.concat(chunks).toString(),
    });
    if (path.pathname.endsWith("/key") && state.holdKeys) {
      entered.resolve();
      await hold.promise;
    }
    const { status, payload } = reply(state, path);
    if (res.destroyed) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());
  const transport: SecretBackendTransport = {
    fetch: globalThis.fetch.bind(globalThis),
    signal: controller.signal,
    assertCurrent() {
      if (controller.signal.aborted)
        throw new SecretBackendError("stale", "Original owner ended");
    },
  };
  const factory = createProtonPassSessions(transport);
  const config: ProtonPassConfiguration = {
    baseUrl: `http://127.0.0.1:${address.port}/tenant/api`,
    token: combined,
    vaultId: "PAT/share",
    appVersion: "web-opensesame@0.1.0",
  };
  const held = {
    state,
    requests,
    config,
    factory,
    controller,
    entered,
    hold,
    async close() {
      controller.abort();
      hold.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(held.close);
  return held;
}

describe("Proton PAT encrypted session foundation over real owned HTTP", () => {
  it("admits only after independent encrypted share keys and vault metadata open", async () => {
    const f = await fixture();
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    expect(held.vaultName).toBe("Synthetic vault");
    expect(held.share.vaultId).toBe("original-vault");
    expect(held.latestRotation).toBe(1);
    expect(held.key(0).extractable).toBe(false);
    expect(session.backendId).toBe("proton-pass");
    expect(Object.isFrozen(session)).toBe(true);
    expect(JSON.stringify(session)).not.toMatch(/private-|pst_|raw|key/i);
    expect(f.requests.map((request) => request.path)).toEqual([
      "/tenant/api/account/v4/personal-access-token/session",
      "/tenant/api/pass/v1/share",
      "/tenant/api/pass/v1/share/PAT%2Fshare/key?Page=0&PageSize=100",
    ]);
    expect(JSON.parse(f.requests[0]?.body ?? "")).toEqual({
      Token: serverToken,
    });
    expect(f.requests[0]?.headers.authorization).toBeUndefined();
    for (const request of f.requests)
      expect(request.headers["x-pm-appversion"]).toBe("web-opensesame@0.1.0");
    expect(f.requests[1]?.headers.authorization).toBe(
      "Bearer private-issued-token",
    );
    expect(f.requests[1]?.headers["x-pm-uid"]).toBe("synthetic-session");
    expect(JSON.stringify(f.requests)).not.toContain(combined);
    expect(JSON.stringify(f.requests)).not.toContain(
      Buffer.from(patKey).toString("base64url"),
    );
    await expect(held.request("item")).resolves.toMatchObject({ Code: 1000 });
  });

  it("retrieves bounded paginated rotations and the exact vault metadata key", async () => {
    const f = await fixture();
    f.state.rotations = 101;
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    expect(held.latestRotation).toBe(100);
    expect(held.vaultName).toBe("Synthetic vault");
    expect(
      f.requests.filter((request) => request.path.includes("/key?")),
    ).toHaveLength(2);
    expect(held.key(0)).not.toBe(held.key(100));
  });

  it.each(["wrongKey", "repeated"])(
    "refuses valid login but %s share keys",
    async (mode) => {
      const f = await fixture();
      if (mode === "wrongKey")
        f.config.token = `${serverToken}::${Buffer.from(new Uint8Array(32).fill(9)).toString("base64url")}`;
      else f.state.repeated = true;
      await expect(f.factory.authenticate(f.config)).rejects.toBeInstanceOf(
        Error,
      );
      expect(f.requests).toHaveLength(3);
    },
  );

  it("ignores PAT Owner=true and enforces a viewer grant before write egress", async () => {
    const f = await fixture();
    f.state.role = "3";
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    expect(held.share.writable).toBe(false);
    await expect(
      held.request("item", { method: "POST" }),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(f.requests).toHaveLength(3);
    await expect(held.request("item")).resolves.toMatchObject({ Code: 1000 });
  });

  it("keeps requests in the configured base and exact PAT-scoped share", async () => {
    const f = await fixture();
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    for (const path of [
      "../../other",
      "https://other.test/item",
      "item#fragment",
    ])
      await expect(held.request(path)).rejects.toMatchObject({
        code: "configuration",
      });
    expect(f.requests).toHaveLength(3);
    expect(() => f.factory.read({ ...session })).toThrowError(
      expect.objectContaining({ code: "authentication" }),
    );
    expect(f.factory.read(session).vaultName).toBe("Synthetic vault");
  });

  it("withdraws actual401 admission and never sends stale authenticated followups", async () => {
    const f = await fixture();
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    f.state.unauthorized = true;
    await expect(held.request("item")).rejects.toMatchObject({ code: "stale" });
    expect(session.signal?.aborted).toBe(true);
    expect(secretBackendSessionClosure(session)).toBe("provider-ended");
    const count = f.requests.length;
    await expect(held.request("item")).rejects.toMatchObject({ code: "stale" });
    expect(() => f.factory.read(session)).toThrow();
    expect(f.requests).toHaveLength(count);
  });

  it("closes local logout synchronously before further HTTP or key use", async () => {
    const f = await fixture();
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    session.signal?.addEventListener(
      "abort",
      () => {
        expect(() => held.key(1)).toThrow();
      },
      { once: true },
    );
    await f.factory.disconnect(session);
    expect(session.signal?.aborted).toBe(true);
    expect(secretBackendSessionClosure(session)).toBe("removed");
    await expect(held.request("item")).rejects.toMatchObject({ code: "stale" });
    expect(f.requests).toHaveLength(3);
  });

  it("withdraws a pending real key response without admitting or following up", async () => {
    const f = await fixture();
    f.state.holdKeys = true;
    const pending = f.factory.authenticate(f.config);
    const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
    await f.entered.promise;
    f.controller.abort();
    f.hold.resolve();
    await rejected;
    expect(f.requests).toHaveLength(3);
  });

  it("expires at actual provider deadline without refresh or later request", async () => {
    const f = await fixture();
    f.state.expires = Math.floor(Date.now() / 1000) + 2;
    const session = await f.factory.authenticate(f.config);
    const held = f.factory.read(session);
    await new Promise<void>((resolve) => {
      if (session.signal?.aborted) resolve();
      else
        session.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
    await expect(held.request("item")).rejects.toMatchObject({ code: "stale" });
    expect(f.requests).toHaveLength(3);
    expect(
      f.requests.filter((request) => request.path.endsWith("/session")),
    ).toHaveLength(1);
  });

  it("captures endpoint/header/share configuration before asynchronous login", async () => {
    const f = await fixture();
    f.state.holdKeys = true;
    const pending = f.factory.authenticate(f.config);
    await f.entered.promise;
    f.config.baseUrl = "https://other.test/api";
    f.config.appVersion = "web-other@1";
    f.config.vaultId = "another-share";
    f.hold.resolve();
    const session = await pending;
    await expect(
      f.factory.read(session).request("item"),
    ).resolves.toMatchObject({ Code: 1000 });
    expect(
      f.requests.every((request) => request.path.startsWith("/tenant/api/")),
    ).toBe(true);
    expect(f.requests.at(-1)?.headers["x-pm-appversion"]).toBe(
      "web-opensesame@0.1.0",
    );
  });

  it.each(["token", "header", "share", "code", "itemShare"])(
    "rejects invalid %s before inappropriate followups",
    async (mode) => {
      const f = await fixture();
      if (mode === "token")
        f.config.token = `${serverToken}::not-a-32-byte-key`;
      if (mode === "header")
        f.config.appVersion = "first-party-header\r\ninvalid";
      if (mode === "share") f.config.vaultId = "..";
      if (mode === "code") f.state.code = 2001;
      if (mode === "itemShare") f.state.targetType = 2;
      await expect(f.factory.authenticate(f.config)).rejects.toBeInstanceOf(
        Error,
      );
      expect(f.requests.length).toBe(
        mode === "code" ? 1 : mode === "itemShare" ? 2 : 0,
      );
    },
  );
});
