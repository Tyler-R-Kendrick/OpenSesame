import { type Server, createServer } from "node:http";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../../host.js";
import { createMemoryStorage } from "../../memory-storage.js";
import type { PagePort } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { deviceIdentitySeams } from "../device-identity.js";
import * as mfaRoute from "../identity-mfa-authentication.js";
import { kvForgetAll } from "../kv.js";
import { vfsFlush } from "../vfs.js";
import * as permits from "./remote-code-admission.js";
import { remoteCodeSeams, verifyCode } from "./remote-code.js";
import * as authHeader from "./store-auth-header.js";
import { VaultStore } from "./store.js";

const PASSWORD = "actual remote factor owner current password";
const CODE = "482915";
let server: Server | undefined;
let requests: Array<{ path: string; payload: string }>;
let base: string;
let challenge = 0;
let holdSend: (() => Promise<void>) | null = null;
let holdVerify: (() => Promise<void>) | null = null;
const stores: VaultStore[] = [];
type ObservedPrimaryPermit = { permit: permits.MfaAuthenticationPermit | null };
const originalRemote = deviceIdentitySeams.remoteIdentityApi;

function page(origin: string): PagePort {
  return {
    location: Object.assign(new URL(origin), {
      assign: () => {},
      replace: () => {},
      reload: () => {},
    }),
    opener: null,
    isSecureContext: true,
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => null,
    close: () => {},
    replaceUrl: () => {},
    onVisibilityChange: () => () => {},
    startDownload: () => {},
    submitForm: () => {},
  };
}
beforeEach(async () => {
  await vfsFlush();
  kvForgetAll();
  vi.stubGlobal("navigator", { locks: webLocksDouble() });
  requests = [];
  challenge = 0;
  holdSend = null;
  holdVerify = null;
  const codes = new Map<string, string>();
  server = createServer(async (request, response) => {
    let payload = "";
    for await (const chunk of request) payload += chunk.toString();
    const path = request.url ?? "";
    requests.push({ path, payload });
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const body = JSON.parse(payload);
    if (path === "/v1/mfa/code/send" && body.channel === "email") {
      const id = `actual-local-challenge-${++challenge}`;
      codes.set(id, CODE);
      await holdSend?.();
      response.end(
        JSON.stringify({
          challengeId: id,
          to: "o•••@example.test",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        }),
      );
    } else if (
      path === "/v1/mfa/code/verify" &&
      codes.get(body.challengeId) === body.code
    ) {
      codes.delete(body.challengeId);
      await holdVerify?.();
      response.writeHead(204).end();
    } else
      response.writeHead(401).end(JSON.stringify({ error: "invalid_code" }));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = z
    .object({ port: z.number().int().min(1).max(65535) })
    .parse(server.address());
  base = `http://127.0.0.1:${address.port}`;
  configureHost(
    createTestHost({
      page: page(base),
      securityProfile: {
        version: 1,
        profile: "loopback_development",
        canonicalOrigin: base,
        headerSecurity: false,
      },
      storage: { local: createMemoryStorage(), session: createMemoryStorage() },
    }),
  );
  deviceIdentitySeams.remoteIdentityApi = () => base;
});
afterEach(async () => {
  for (const store of stores.splice(0)) store.lock();
  deviceIdentitySeams.remoteIdentityApi = originalRemote;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureHost(createTestHost());
});
function newStore() {
  const store = new VaultStore();
  stores.push(store);
  return store;
}
async function pendingOwnerAndPeer() {
  const owner = newStore();
  await owner.create(PASSWORD);
  await owner.saveItem(createItem("note", "Genuine owner note"));
  await owner.beginCodeEnrollment("email", "owner@example.test");
  await owner.confirmCodeEnrollment(CODE);
  owner.lock();
  const peer = newStore();
  await peer.unlock(PASSWORD);
  await peer.requestSecondStepCode("email");
  await peer.confirmRemoteCode(CODE);
  await owner.unlock(PASSWORD);
  expect(owner.getSnapshot().awaitingSecondStep).toBe(true);
  expect(owner.isUnlocked()).toBe(false);
  return { owner, peer };
}

it.each(["password", "remove-factor"] as const)(
  "withholds remote factor traffic from a primary proof retired by a peer %s update",
  async (change) => {
    const { owner, peer } = await pendingOwnerAndPeer();
    if (change === "password")
      await peer.changeMasterPassword(
        PASSWORD,
        "replacement current remote factor owner",
      );
    else await peer.removeCode("email");
    requests = [];
    const delivery = await owner.requestSecondStepCode("email").then(
      () => null,
      (error: Error) => error,
    );
    const sends = requests.filter((r) => r.path === "/v1/mfa/code/send");
    // A successful-looking stale factor delivery must still never publish real authority.
    if (!delivery)
      await expect(owner.confirmRemoteCode(CODE)).rejects.toThrow(
        /authentication changed/,
      );
    expect(owner.isUnlocked()).toBe(false);
    expect(owner.getSnapshot().items).toEqual([]);
    expect(peer.isUnlocked()).toBe(true);
    console.info("actual stale-factor observation", {
      change,
      sentPosts: sends.length,
      primaryAdmissionBlocked: !owner.isUnlocked(),
    });
    expect(sends).toHaveLength(0);
    expect(delivery).toBeInstanceOf(Error);
  },
);

function deferred() {
  let finish = () => {};
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: () => finish() };
}

it.each([false, true])(
  "withholds dispatch when genuine durable validation crosses public lock (fresh successor=%s)",
  async (successor) => {
    const { owner } = await pendingOwnerAndPeer();
    const reached = deferred();
    const blocked = deferred();
    const actual = authHeader.validateAuthenticationHeader;
    vi.spyOn(authHeader, "validateAuthenticationHeader").mockImplementationOnce(
      async (...args) => {
        await actual(...args);
        reached.finish();
        await blocked.promise;
      },
    );
    requests = [];
    const pending = owner.requestSecondStepCode("email").then(
      () => null,
      (error: Error) => error,
    );
    try {
      await reached.promise;
      owner.lock();
      if (successor) {
        await owner.unlock(PASSWORD);
        await owner.requestSecondStepCode("email");
        await owner.confirmRemoteCode(CODE);
        expect(owner.isUnlocked()).toBe(true);
      }
      const current = owner.getSnapshot();
      const posts = requests.length;
      blocked.finish();
      expect(await pending).toBeInstanceOf(Error);
      expect(requests).toHaveLength(posts);
      expect(owner.getSnapshot()).toEqual(current);
      if (successor) {
        // Genuine wrapping and subsequent unwrap prove stale cleanup did not zero successor raw.
        await owner.enrollPin("48291037");
        owner.lock();
        await owner.unlockWithPin("48291037");
        await owner.requestSecondStepCode("email");
        await owner.confirmRemoteCode(CODE);
        expect(owner.getSnapshot().items.map((item) => item.name)).toContain(
          "Genuine owner note",
        );
      } else expect(owner.isUnlocked()).toBe(false);
    } finally {
      blocked.finish();
      await pending;
    }
  },
);

it("withholds the returned challenge when peer policy changes after an authorized send dispatch", async () => {
  const { owner, peer } = await pendingOwnerAndPeer();
  const reached = deferred();
  const blocked = deferred();
  holdSend = async () => {
    reached.finish();
    await blocked.promise;
  };
  requests = [];
  const pending = owner.requestSecondStepCode("email").then(
    () => null,
    (error: Error) => error,
  );
  try {
    await reached.promise;
    await peer.removeCode("email");
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(requests.filter((r) => r.path === "/v1/mfa/code/send")).toHaveLength(
      1,
    );
    expect(owner.pendingSecondStepCode()).toBeNull();
    expect(owner.isUnlocked()).toBe(false);
    expect(peer.isUnlocked()).toBe(true);
  } finally {
    blocked.finish();
    await pending;
  }
});

it("refuses an old verification response after a genuine resend changes the permit challenge", async () => {
  const { owner } = await pendingOwnerAndPeer();
  const first = await owner.requestSecondStepCode("email");
  const reached = deferred();
  const blocked = deferred();
  holdVerify = async () => {
    reached.finish();
    await blocked.promise;
  };
  const pending = owner.confirmRemoteCode(CODE).then(
    () => null,
    (error: Error) => error,
  );
  try {
    await reached.promise;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60000);
    const current = await owner.requestSecondStepCode("email");
    expect(current.challengeId).not.toBe(first.challengeId);
    blocked.finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(owner.isUnlocked()).toBe(false);
    expect(owner.pendingSecondStepCode()?.challengeId).toBe(
      current.challengeId,
    );
    holdVerify = null;
    await owner.confirmRemoteCode(CODE);
    expect(owner.isUnlocked()).toBe(true);
  } finally {
    blocked.finish();
    await pending;
  }
});

it.each(["lock", "cancel-challenge"] as const)(
  "withholds dispatch when public %s runs in the genuine permit-validation helper return microtask",
  async (transition) => {
    const { owner } = await pendingOwnerAndPeer();
    const actual = permits.validateMfaAuthenticationPermit;
    vi.spyOn(permits, "validateMfaAuthenticationPermit").mockImplementationOnce(
      async (...args) => {
        await actual(...args);
        queueMicrotask(() => {
          if (transition === "lock") owner.lock();
          else owner.cancelTotpChallenge();
        });
      },
    );
    requests = [];
    await expect(owner.requestSecondStepCode("email")).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(owner.isUnlocked()).toBe(false);
  },
);

it.each(["lock", "cancel-challenge"] as const)(
  "refuses a real verification whose helper return microtask invokes public %s",
  async (transition) => {
    const { owner } = await pendingOwnerAndPeer();
    const observed: ObservedPrimaryPermit = {
      permit: null,
    };
    const route = mfaRoute.identityMfaAuthentication;
    vi.spyOn(mfaRoute, "identityMfaAuthentication").mockImplementationOnce(
      async (request, permit) => {
        observed.permit = permit;
        return route(request, permit);
      },
    );
    const sent = await owner.requestSecondStepCode("email");
    if (!observed.permit)
      throw new Error("Expected genuine private primary permit");
    const actual = remoteCodeSeams.verifyCode;
    vi.spyOn(remoteCodeSeams, "verifyCode").mockImplementationOnce(
      async (...args) => {
        await actual(...args);
        queueMicrotask(() => {
          if (transition === "lock") owner.lock();
          else owner.cancelTotpChallenge();
        });
      },
    );
    await expect(
      verifyCode(sent.challengeId, CODE, observed.permit),
    ).rejects.toThrow();
    expect(owner.isUnlocked()).toBe(false);
  },
);
