import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendHttp } from "./http.js";
import { createInfisicalLifetime } from "./infisical-lifetime.js";
import { createInfisicalBackend } from "./infisical.js";
import { secretBackendDraft } from "./presets.js";
import { secretBackendSessionClosure } from "./sessions.js";
import type { SecretBackendFetch, SecretBackendSession } from "./types.js";

const token = "private-issued-token";
const empty = () => Response.json({ secrets: [] });
type LoginReply = {
  accessToken: string;
  expiresIn?: BoundaryValue;
  accessTokenMaxTTL?: number;
  tokenType?: string;
};

function delayed() {
  let deliver: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  return {
    promise,
    resolve(response: Response) {
      if (!deliver) throw new Error("Missing controlled response");
      deliver(response);
    },
  };
}

function fixture() {
  const login: LoginReply = {
    accessToken: token,
    expiresIn: 1,
    accessTokenMaxTTL: 100,
    tokenType: "Bearer",
  };
  const replies: (() => Response | Promise<Response>)[] = [];
  const fetcher = vi.fn<SecretBackendFetch>(async (input) => {
    if (String(input).endsWith("/login")) return Response.json(login);
    return replies.shift()?.() ?? empty();
  });
  const backend = createInfisicalBackend(fetcher);
  const config = {
    ...secretBackendDraft("infisical"),
    baseUrl: "https://infisical.example.test",
    projectId: "project",
    environment: "dev",
    secretPath: "/backup",
    clientId: "machine",
    clientSecret: "private-client-secret",
  };
  return { login, replies, fetcher, backend, config };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Infisical issued-token lifetime", () => {
  it("ends idle authority at issued seconds, never maxTTL or a wall setback", async () => {
    const f = fixture();
    const session = await f.backend.authenticate(f.config);
    expect(session.signal?.aborted).toBe(false);
    expect(JSON.stringify(session)).not.toContain("private-");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    vi.setSystemTime(Date.now() - 10_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.signal?.aborted).toBe(true);
    expect(secretBackendSessionClosure(session)).toBe("provider-ended");
    expect(session.signal?.reason.name).toBe("AbortError");
    const calls = f.fetcher.mock.calls.length;
    await expect(f.backend.listItems(session)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null, "1", 0, -1, 1e13, 1e308])(
    "rejects invalid expiresIn %s without validation I/O or a timer",
    async (expiresIn) => {
      const f = fixture();
      f.login.expiresIn = expiresIn;
      await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
        code: "response",
      });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it.each(["accessTokenMaxTTL", "tokenType"] as const)(
    "requires the documented %s response field",
    async (field) => {
      const f = fixture();
      f.login[field] = undefined;
      await expect(f.backend.authenticate(f.config)).rejects.toMatchObject({
        code: "response",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses the prelogin origin and rejects an already-expired token delivery", async () => {
    const f = fixture();
    const pending = delayed();
    f.fetcher.mockImplementationOnce(() => pending.promise);
    const result = f.backend.authenticate(f.config);
    await vi.advanceTimersByTimeAsync(1100);
    pending.resolve(Response.json(f.login));
    await expect(result).rejects.toMatchObject({ code: "authentication" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts fractional issued seconds and expires without rounding up", async () => {
    const f = fixture();
    f.login.expiresIn = 0.125;
    const session = await f.backend.authenticate(f.config);
    await vi.advanceTimersByTimeAsync(124);
    expect(session.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.signal?.aborted).toBe(true);
  });

  it("expires during initial validation and refuses its late successful delivery", async () => {
    const f = fixture();
    const pending = delayed();
    f.replies.push(() => pending.promise);
    const result = f.backend.authenticate(f.config);
    await vi.advanceTimersByTimeAsync(0);
    const signal = f.fetcher.mock.calls[1]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal?.aborted).toBe(true);
    pending.resolve(empty());
    await expect(result).rejects.toMatchObject({ code: "authentication" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["permission", "network", "malformed"])(
    "disposes failed initial validation: %s",
    async (mode) => {
      const f = fixture();
      f.replies.push(() => {
        if (mode === "network") throw new Error("private-network-reason");
        return mode === "permission"
          ? Response.json({ error: "PermissionDenied" }, { status: 403 })
          : Response.json({ secrets: "bad" });
      });
      await expect(f.backend.authenticate(f.config)).rejects.toBeInstanceOf(
        Error,
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(f.fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    },
  );

  it.each([false, true])(
    "checks expiry before I/O and after delayed delivery=%s",
    async (delayedReply) => {
      const f = fixture();
      const session = await f.backend.authenticate(f.config);
      const pending = delayed();
      if (delayedReply) f.replies.push(() => pending.promise);
      const calls = f.fetcher.mock.calls.length;
      const result = delayedReply ? f.backend.listItems(session) : null;
      vi.setSystemTime(Date.now() + 2000);
      if (result) pending.resolve(empty());
      await expect(
        result ?? f.backend.listItems(session),
      ).rejects.toMatchObject({ code: "authentication" });
      expect(session.signal?.aborted).toBe(true);
      expect(f.fetcher).toHaveBeenCalledTimes(calls + Number(delayedReply));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rearms long TTL without timer overflow and accepts maxTTL0", async () => {
    const f = fixture();
    f.login.expiresIn = (2_147_483_647 + 500) / 1000;
    f.login.accessTokenMaxTTL = 0;
    const session = await f.backend.authenticate(f.config);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(session.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(session.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not infer a deadline for an opaque manual token, but401 ends it", async () => {
    const f = fixture();
    const session = await f.backend.authenticate({
      ...f.config,
      clientId: "",
      clientSecret: "",
      token,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(await f.backend.listItems(session)).toEqual([]);
    f.replies.push(() =>
      Response.json({ error: "private-token-error" }, { status: 401 }),
    );
    await expect(f.backend.listItems(session)).rejects.toMatchObject({
      status: 401,
    });
    expect(session.signal?.aborted).toBe(true);
  });
});

describe("Infisical exact-session terminal handling", () => {
  it("checks getNotes after actual getItem HTTP and codec finish", async () => {
    const f = fixture();
    const session = await f.backend.authenticate(f.config);
    f.replies.push(() =>
      Response.json({
        secret: {
          secretKey: "note",
          secretValue: "value",
          secretComment: "notes",
        },
      }),
    );
    const getItem = f.backend.getItem.bind(f.backend);
    f.backend.getItem = async (name, owner) => {
      const item = await getItem(name, owner);
      vi.setSystemTime(Date.now() + 2000);
      return item;
    };
    await expect(f.backend.getNotes("note", session)).rejects.toMatchObject({
      code: "authentication",
    });
    expect(session.signal?.aborted).toBe(true);
    expect(secretBackendSessionClosure(session)).toBe("provider-ended");
  });

  it.each([false, true])(
    "preserves a caller-only cancellation without retiring the token, alreadyended=%s",
    async (alreadyEnded) => {
      const f = fixture();
      const lifetime = createInfisicalLifetime(
        createBackendHttp(f.config.baseUrl, f.fetcher),
      );
      lifetime.install(token, null);
      const caller = new AbortController();
      const pending = delayed();
      f.replies.push(() => pending.promise);
      if (alreadyEnded) caller.abort(new Error("private-caller-reason"));
      const result = lifetime.call("/api/v4/secrets", {
        signal: caller.signal,
      });
      if (!alreadyEnded) {
        const signal = f.fetcher.mock.calls[0]?.[1]?.signal;
        caller.abort(new Error("private-caller-reason"));
        expect(signal?.aborted).toBe(true);
        pending.resolve(empty());
      }
      await expect(result).rejects.toMatchObject({ code: "stale" });
      expect(lifetime.signal.aborted).toBe(false);
      expect(f.fetcher).toHaveBeenCalledTimes(Number(!alreadyEnded));
      f.replies.length = 0;
      expect(await lifetime.call("/api/v4/secrets")).toEqual({ secrets: [] });
      lifetime.close();
    },
  );

  it.each([401, 403])(
    "retires only the captured session before delivering HTTP%s",
    async (status) => {
      const f = fixture();
      const old = await f.backend.authenticate(f.config);
      const sibling = await f.backend.authenticate(f.config);
      const pending = delayed();
      f.replies.push(() => pending.promise);
      const late = f.backend.listItems(old);
      const pendingSignal = f.fetcher.mock.calls.at(-1)?.[1]?.signal;
      let replacement: Promise<SecretBackendSession> | undefined;
      old.signal?.addEventListener("abort", () => {
        expect(secretBackendSessionClosure(old)).toBe("provider-ended");
        f.login.expiresIn = 10;
        replacement = f.backend.authenticate(f.config);
      });
      f.replies.push(() =>
        Response.json(
          { statusCode: status, error: "TokenError", message: token },
          { status },
        ),
      );
      const failed = f.backend.listItems(old);
      await expect(failed).rejects.toMatchObject({ status });
      expect(old.signal?.aborted).toBe(true);
      expect(pendingSignal?.aborted).toBe(true);
      expect(sibling.signal?.aborted).toBe(false);
      pending.resolve(
        Response.json({ error: "private-old-token" }, { status: 401 }),
      );
      await expect(late).rejects.toMatchObject({ code: "authentication" });
      if (!replacement) throw new Error("Missing reentrant replacement");
      const fresh = await replacement;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fresh.signal?.aborted).toBe(false);
      expect(await f.backend.listItems(fresh)).toEqual([]);
      const error = await failed.catch((failure: Error) => failure);
      expect(
        JSON.stringify(Object.getOwnPropertyDescriptors(error)),
      ).not.toContain("private-");
    },
  );

  it.each([
    "permission",
    "unknown403",
    "rate",
    "server",
    "network",
    "malformed",
  ])("keeps %s failures ordinary and permits a later request", async (mode) => {
    const f = fixture();
    const session = await f.backend.authenticate(f.config);
    f.replies.push(() => {
      if (mode === "network") throw new Error("private-network-token");
      if (mode === "malformed") return Response.json({ secrets: "bad" });
      const status = mode === "rate" ? 429 : mode === "server" ? 500 : 403;
      return Response.json(
        {
          statusCode: status,
          error: mode === "permission" ? "PermissionDenied" : "Unknown",
          message: token,
        },
        { status },
      );
    });
    await expect(f.backend.listItems(session)).rejects.toBeInstanceOf(Error);
    expect(session.signal?.aborted).toBe(false);
    expect(secretBackendSessionClosure(session)).toBeNull();
    expect(await f.backend.listItems(session)).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await f.backend.disconnect(session);
  });

  it("removes authority before normal native abort and cancels the timer idempotently", async () => {
    const f = fixture();
    const session = await f.backend.authenticate(f.config);
    const count = f.fetcher.mock.calls.length;
    let observed: string | null = null;
    session.signal?.addEventListener("abort", () => {
      observed = secretBackendSessionClosure(session);
    });
    await expect(f.backend.listItems({ ...session })).rejects.toMatchObject({
      code: "authentication",
    });
    await f.backend.disconnect(session);
    await f.backend.disconnect(session);
    expect(secretBackendSessionClosure(session)).toBe("removed");
    expect(observed).toBe("removed");
    expect(session.signal?.aborted).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    const fresh = await f.backend.authenticate(f.config);
    await f.backend.disconnect(session);
    expect(fresh.signal?.aborted).toBe(false);
    expect(await f.backend.listItems(fresh)).toEqual([]);
  });
});
