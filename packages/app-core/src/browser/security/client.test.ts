import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it } from "vitest";
import { SECURITY_PORT, type SecurityRequest } from "./broker.js";
import { type PagePort, type PageRuntime, securityClient } from "./client.js";

function fixture() {
  const sent: SecurityRequest[] = [];
  let message: (reply: BoundaryValue) => void = () => undefined;
  let disconnect: () => void = () => undefined;
  let postThrows = false;
  let attemptedPosts = 0;
  let disconnected = 0;
  const port: PagePort = {
    postMessage: (request) => {
      attemptedPosts += 1;
      if (postThrows) throw new Error("Worker port closed");
      sent.push(request);
    },
    onMessage: {
      addListener: (listener) => {
        message = listener;
      },
    },
    onDisconnect: {
      addListener: (listener) => {
        disconnect = listener;
      },
    },
  };
  const runtime: PageRuntime = {
    connect: (options) => {
      expect(options).toEqual({ name: SECURITY_PORT });
      return port;
    },
  };
  const client = securityClient(runtime, () => {
    disconnected += 1;
  });
  return {
    client,
    sent,
    emit: (reply: BoundaryValue) => message(reply),
    disconnect: () => disconnect(),
    failPosts: () => {
      postThrows = true;
    },
    disconnectCount: () => disconnected,
    attemptedPosts: () => attemptedPosts,
  };
}

it("holds only the permit returned for its current real unlock", async () => {
  const f = fixture();
  const pending = f.client.unlock("owner-current");
  expect(f.sent).toEqual([{ id: 0, op: "unlock", password: "owner-current" }]);
  expect(f.client.permit()).toBeUndefined();
  f.emit({ id: 0, realm: "real", permit: "worker-issued-real" });
  await expect(pending).resolves.toEqual({
    id: 0,
    realm: "real",
    permit: "worker-issued-real",
  });
  expect(f.client.permit()).toBe("worker-issued-real");
});

it("does not restore a permit from an unlock reply arriving after lock", async () => {
  const f = fixture();
  const pending = f.client.unlock("owner-current");
  f.client.lock();
  f.emit({ id: 0, realm: "real", permit: "late-real-permit" });
  await expect(pending).resolves.toEqual({ id: 0, realm: "locked" });
  expect(f.client.permit()).toBeUndefined();
  expect(f.sent.at(-1)).toEqual({ id: 1, op: "lock" });
});

it("keeps the newer classification when concurrent replies arrive out of order", async () => {
  const f = fixture();
  const older = f.client.unlock("owner-current");
  const newer = f.client.unlock("selected-retired");
  f.emit({
    id: 1,
    realm: "synthetic",
    permit: "worker-issued-synthetic",
    trap: {
      id: "selected",
      createdAt: "2026-10-05T00:00:00.000Z",
      response: "synthetic_decoy",
    },
  });
  await expect(newer).resolves.toMatchObject({ id: 1, realm: "synthetic" });
  f.emit({ id: 0, realm: "real", permit: "superseded-real" });
  await expect(older).resolves.toEqual({ id: 0, realm: "locked" });
  expect(f.client.permit()).toBe("worker-issued-synthetic");
});

it("fails closed when disconnect races the unlock reply's promise continuation", async () => {
  const f = fixture();
  const pending = f.client.unlock("owner-current");
  f.emit({ id: 0, realm: "real", permit: "issued-before-disconnect" });
  f.disconnect();
  await expect(pending).resolves.toEqual({ id: 0, realm: "locked" });
  expect(f.client.permit()).toBeUndefined();
  expect(f.disconnectCount()).toBe(1);
});

it("disconnect clears an admitted permit and prevents later posts or late reply admission", async () => {
  const f = fixture();
  const admitted = f.client.unlock("owner-current");
  f.emit({ id: 0, realm: "real", permit: "current-permit" });
  await admitted;
  f.disconnect();
  expect(f.client.permit()).toBeUndefined();
  const count = f.sent.length;
  expect(() => f.client.lock()).not.toThrow();
  await expect(f.client.unlock("owner-current")).resolves.toMatchObject({
    realm: "locked",
  });
  f.emit({ id: 0, realm: "real", permit: "replayed-permit" });
  expect(f.client.permit()).toBeUndefined();
  expect(f.sent).toHaveLength(count);
});

it("disconnect resolves a pending unlock as locked", async () => {
  const f = fixture();
  const pending = f.client.unlock("owner-current");
  f.disconnect();
  f.emit({ id: 0, realm: "real", permit: "late-worker-permit" });
  await expect(pending).resolves.toEqual({ id: 0, realm: "locked" });
  expect(f.client.permit()).toBeUndefined();
});

it("post failures resolve as locked and lock never throws on a dead port", async () => {
  const f = fixture();
  f.failPosts();
  await expect(f.client.unlock("owner-current")).resolves.toMatchObject({
    realm: "locked",
  });
  expect(f.client.permit()).toBeUndefined();
  expect(() => f.client.lock()).not.toThrow();
  await expect(f.client.unlock("owner-current")).resolves.toMatchObject({
    realm: "locked",
  });
});

it("ignores unsolicited and malformed messages instead of accepting caller-supplied authority", async () => {
  const f = fixture();
  const pending = f.client.unlock("owner-current");
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  f.emit({ id: 99, realm: "real", permit: "unsolicited" });
  f.emit({ id: 0, realm: "owner", permit: "invalid-realm" });
  f.emit({ id: 0, realm: "real", permit: 77 });
  f.emit({ id: 0, realm: "synthetic", trap: {} });
  f.emit({
    id: 0,
    realm: "synthetic",
    trap: { id: "selected", createdAt: "today", response: "wipe" },
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.client.permit()).toBeUndefined();
  f.emit({ id: 0, realm: "locked" });
  await expect(pending).resolves.toEqual({ id: 0, realm: "locked" });
  expect(f.client.permit()).toBeUndefined();
});

it("round-trips worker authorization using the current page permit", async () => {
  const f = fixture();
  const admitted = f.client.unlock("owner-current");
  f.emit({ id: 0, realm: "real", permit: "worker-issued-real" });
  await admitted;
  const pending = f.client.authorize();
  expect(f.sent.at(-1)).toEqual({
    id: 1,
    op: "authorize",
    permit: "worker-issued-real",
  });
  f.emit({ id: 1, realm: "real" });
  await expect(pending).resolves.toBe(true);
});

it("pending authorization refuses late real replies after lock or disconnect", async () => {
  for (const interruption of ["lock", "disconnect"]) {
    const f = fixture();
    const pending = f.client.authorize();
    if (interruption === "lock") f.client.lock();
    else f.disconnect();
    f.emit({ id: 0, realm: "real" });
    await expect(pending).resolves.toBe(false);
    expect(f.client.permit()).toBeUndefined();
  }
});

it("does not authorize if lock races a real reply's promise continuation", async () => {
  const f = fixture();
  const pending = f.client.authorize();
  f.emit({ id: 0, realm: "real" });
  f.client.lock();
  await expect(pending).resolves.toBe(false);
});

it("authorization refuses worker denial, synthetic replies, dead ports, and post failures", async () => {
  for (const realm of ["locked", "synthetic"]) {
    const f = fixture();
    const pending = f.client.authorize();
    f.emit({ id: 0, realm });
    await expect(pending).resolves.toBe(false);
  }
  const disconnected = fixture();
  disconnected.disconnect();
  await expect(disconnected.client.authorize()).resolves.toBe(false);
  expect(disconnected.sent).toEqual([]);
  const failed = fixture();
  failed.failPosts();
  await expect(failed.client.authorize()).resolves.toBe(false);
});

it("bounds pending authorizations and recovers capacity after both replies and lock", async () => {
  const f = fixture();
  const pending = Array.from({ length: 32 }, () => f.client.authorize());
  await expect(f.client.authorize()).resolves.toBe(false);
  expect(f.sent).toHaveLength(32);
  f.emit({ id: 0, realm: "real" });
  await expect(pending[0]).resolves.toBe(true);
  const replacement = f.client.authorize();
  expect(f.sent.at(-1)).toEqual({ id: 32, op: "authorize" });
  f.client.lock();
  await expect(Promise.all(pending.slice(1))).resolves.toEqual(
    Array.from({ length: 31 }, () => false),
  );
  await expect(replacement).resolves.toBe(false);
  const fresh = f.client.authorize();
  expect(f.sent.at(-1)).toEqual({ id: 34, op: "authorize" });
  f.emit({ id: 34, realm: "real" });
  await expect(fresh).resolves.toBe(true);
});

it("releases failed-post slots and stops using a port whose lock post failed", async () => {
  const f = fixture();
  f.failPosts();
  for (let index = 0; index < 40; index++)
    await expect(f.client.authorize()).resolves.toBe(false);
  expect(f.attemptedPosts()).toBe(40);
  f.client.lock();
  await expect(f.client.authorize()).resolves.toBe(false);
  expect(f.attemptedPosts()).toBe(41);
});

it("withholds a delivered real unlock when lock races its promise continuation", async () => {
  const f = fixture();
  const pending = f.client.unlock("owner-current");
  f.emit({ id: 0, realm: "real", permit: "stale-real" });
  f.client.lock();
  await expect(pending).resolves.toEqual({ id: 0, realm: "locked" });
  expect(f.client.permit()).toBeUndefined();
});
