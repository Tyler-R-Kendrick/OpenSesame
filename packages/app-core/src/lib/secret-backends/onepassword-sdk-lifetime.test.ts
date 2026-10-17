import { afterEach, expect, it, vi } from "vitest";
import type { OnePasswordSdkClient } from "./onepassword-sdk-loader.js";
import {
  deferred,
  nativeOverview,
  nativeVault,
  sdkFixture,
} from "./onepassword-sdk.test-support.js";
import { secretBackendSessionClosure } from "./sessions.js";

afterEach(() => vi.restoreAllMocks());
it.each(["owner", "native"] as const)(
  "refuses an already-ended %s before admission",
  async (cause) => {
    const f = sdkFixture();
    f[cause].abort("private-native-marker");
    await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
      code: "stale",
    });
    expect(f.invoke).not.toHaveBeenCalled();
    if (cause === "owner") expect(f.factory).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  },
);
it("rejects owner loss promptly and disposes a noncooperative late factory client once", async () => {
  const f = sdkFixture();
  const ready = deferred<OnePasswordSdkClient>();
  f.factory.mockReturnValueOnce(ready.promise);
  f.dispose.mockImplementation(() => new Promise(() => {}));
  const pending = f.backend.authenticate(f.config);
  f.owner.abort();
  await expect(pending).rejects.toMatchObject({ code: "stale" });
  ready.resolve(f.client);
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  expect(f.invoke).not.toHaveBeenCalled();
});
it.each([
  ["owner", "VaultsList"],
  ["native", "VaultsList"],
  ["owner", "ItemsList"],
  ["native", "ItemsList"],
] as const)("cancels %s while awaiting native auth %s", async (cause, leg) => {
  const f = sdkFixture();
  const entered = deferred<void>();
  const reply = deferred<void>();
  f.invoke.mockImplementation(async (command) => {
    if (command.name === leg) {
      entered.resolve();
      await reply.promise;
    }
    return command.name === "VaultsList" ? [nativeVault()] : [];
  });
  const pending = f.backend.authenticate(f.config);
  const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  f[cause].abort();
  await cancelled;
  reply.resolve();
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  expect(f.invoke).toHaveBeenCalledTimes(leg === "VaultsList" ? 1 : 2);
});
it.each([2, 3])(
  "disposes once if owner loss wins admission check %i",
  async (stage) => {
    const f = sdkFixture();
    let checks = 0;
    vi.mocked(f.transport.assertCurrent).mockImplementation(() => {
      if (
        f.invoke.mock.calls.some(([command]) => command.name === "ItemsList") &&
        ++checks === stage
      )
        f.owner.abort();
    });
    await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
      code: "stale",
    });
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
  },
);
it("disposes once if the native lifetime ends during registry creation", async () => {
  const f = sdkFixture();
  const add = f.native.signal.addEventListener.bind(f.native.signal);
  vi.spyOn(f.native.signal, "addEventListener").mockImplementation(
    (...args) => {
      add(...args);
      f.native.abort();
    },
  );
  await expect(f.backend.authenticate(f.config)).rejects.toBeInstanceOf(Error);
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
});
it("disposes once if owner loss happens while admission subscribes", async () => {
  const f = sdkFixture();
  const add = f.owner.signal.addEventListener.bind(f.owner.signal);
  vi.spyOn(f.owner.signal, "addEventListener").mockImplementation((...args) => {
    add(...args);
    if (f.invoke.mock.calls.length === 2) f.owner.abort();
  });
  await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
    code: "stale",
  });
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
});
it.each([
  ["owner", "hung"],
  ["native", "hung"],
  ["owner", "rejected"],
  ["native", "rejected"],
] as const)(
  "withdraws idle %s authority before %s cleanup settles",
  async (cause, cleanup) => {
    const f = sdkFixture();
    const session = await f.backend.authenticate(f.config);
    f.dispose.mockImplementation(() =>
      cleanup === "hung"
        ? new Promise(() => {})
        : Promise.reject(new Error("private-native-marker")),
    );
    f[cause].abort();
    expect(session.signal?.aborted).toBe(true);
    expect(f.backend.signal?.aborted).toBe(cause === "owner");
    expect(secretBackendSessionClosure(session)).toBe(
      cause === "owner" ? "removed" : "provider-ended",
    );
    await expect(f.backend.listItems(session)).rejects.toMatchObject({
      code: "stale",
    });
    const closed = f.backend.disconnect(session);
    expect(f.backend.disconnect(session)).toBe(closed);
    void closed.catch(() => undefined);
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    expect(f.invoke).toHaveBeenCalledTimes(2);
  },
);
it("retires the exact handle before reentrant intentional disposal and rejects copied/foreign handles", async () => {
  const f = sdkFixture();
  const session = await f.backend.authenticate(f.config);
  const other = sdkFixture();
  await expect(f.backend.listItems({ ...session })).rejects.toMatchObject({
    code: "authentication",
  });
  await expect(other.backend.disconnect(session)).rejects.toMatchObject({
    code: "authentication",
  });
  let reentered: Promise<void> | undefined;
  session.signal?.addEventListener("abort", () => {
    reentered = f.backend.disconnect(session);
  });
  const closed = f.backend.disconnect(session);
  expect(reentered).toBe(closed);
  expect(secretBackendSessionClosure(session)).toBe("removed");
  expect(f.native.signal.aborted).toBe(false);
  await closed;
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.native.signal.aborted).toBe(true);
  expect(f.owner.signal.aborted).toBe(false);
  await f.backend.disconnect(session);
  expect(f.dispose).toHaveBeenCalledOnce();
});
it.each([
  ["owner", "resolve"],
  ["native", "reject"],
] as const)(
  "discards a read's late %s %s without reviving its session",
  async (cause, late) => {
    const f = sdkFixture();
    const session = await f.backend.authenticate(f.config);
    const reply = deferred<void>();
    f.invoke.mockImplementationOnce(async () => {
      await reply.promise;
      if (late === "reject") throw new Error("private-native-marker");
      return [nativeOverview()];
    });
    const pending = f.backend.listItems(session);
    const cancelled = expect(pending).rejects.toMatchObject({ code: "stale" });
    f[cause].abort();
    await cancelled;
    reply.resolve();
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
    await expect(f.backend.listItems(session)).rejects.toMatchObject({
      code: "stale",
    });
    expect(f.invoke).toHaveBeenCalledTimes(3);
  },
);
it("old provider retirement and repeated cleanup leave a replacement session usable", async () => {
  const f = sdkFixture();
  const original = await f.backend.authenticate(f.config);
  const other = sdkFixture();
  f.factory.mockResolvedValueOnce(other.client);
  const replacement = await f.backend.authenticate(f.config);
  f.native.abort();
  await f.backend.disconnect(original);
  await f.backend.disconnect(original);
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(replacement.signal?.aborted).toBe(false);
  expect(await f.backend.listItems(replacement)).toHaveLength(1);
  expect(other.dispose).not.toHaveBeenCalled();
  await f.backend.disconnect(replacement);
  expect(other.dispose).toHaveBeenCalledOnce();
});
it("retains a sanitized primary auth failure if exact-client disposal throws", async () => {
  const f = sdkFixture();
  f.invoke.mockRejectedValueOnce(new Error("private-native-marker"));
  f.dispose.mockImplementation(() => {
    throw new Error("synthetic-native-token-marker");
  });
  await expect(f.backend.authenticate(f.config)).rejects.toThrow(
    "1Password could not complete the native vault operation.",
  );
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
});
