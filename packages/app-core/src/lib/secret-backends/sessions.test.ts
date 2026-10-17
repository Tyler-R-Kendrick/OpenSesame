import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createSecretBackendSessions,
  secretBackendSessionClosure,
} from "./sessions.js";
import type { SecretBackendSession } from "./types.js";

afterEach(() => vi.restoreAllMocks());

// Validate a captured original allocation without cloning its identity.
const originalSession = z.custom<SecretBackendSession>(
  (value) =>
    z
      .object({
        id: z.string(),
        backendId: z.string(),
        authenticatedAt: z.string(),
        signal: z.instanceof(AbortSignal),
      })
      .safeParse(value).success,
);

function signalOf(session: SecretBackendSession): AbortSignal {
  if (!session.signal) throw new Error("Registry session has no lifetime");
  return session.signal;
}

describe("opaque secret backend sessions", () => {
  it("rejects copied, revoked and foreign handles without exposing credentials", () => {
    const sessions = createSecretBackendSessions<{ token: string }>("fixture");
    const session = sessions.create({ token: "scoped-fixture" });
    expect(secretBackendSessionClosure(session)).toBeNull();
    expect(JSON.stringify(session)).not.toContain("scoped-fixture");
    expect(sessions.read(session).token).toBe("scoped-fixture");
    expect(() => sessions.read({ ...session })).toThrow();
    const foreign = createSecretBackendSessions<object>("fixture").create({});
    expect(() => sessions.read(foreign)).toThrow();
    sessions.remove(session);
    expect(secretBackendSessionClosure(session)).toBe("removed");
    expect(() => sessions.read(session)).toThrow();
  });

  it("freezes the original handle with a readonly non-enumerable owned signal", () => {
    const sessions = createSecretBackendSessions<{ token: string }>("fixture");
    const native = new AbortController();
    const state = { token: "private-native-credential" };
    const session = sessions.create(state, native.signal);
    expect(sessions.read(session)).toBe(state);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.keys(session)).toEqual([
      "id",
      "backendId",
      "authenticatedAt",
    ]);
    expect(JSON.parse(JSON.stringify(session))).toEqual({
      id: session.id,
      backendId: "fixture",
      authenticatedAt: session.authenticatedAt,
    });
    expect(Object.getOwnPropertyDescriptor(session, "signal")).toEqual({
      value: signalOf(session),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(signalOf(session)).not.toBe(native.signal);
    expect(signalOf(session).aborted).toBe(false);
    expect(Reflect.set(session, "signal", new AbortController().signal)).toBe(
      false,
    );
    expect(JSON.stringify(session)).not.toContain(state.token);
    sessions.remove(session);
    expect(signalOf(session).aborted).toBe(true);
  });

  it("removes authority and detaches the native listener before public notification", () => {
    const sessions = createSecretBackendSessions<{ token: string }>("fixture");
    const native = new AbortController();
    const add = vi.spyOn(native.signal, "addEventListener");
    const detach = vi.spyOn(native.signal, "removeEventListener");
    const session = sessions.create({ token: "private-token" }, native.signal);
    const notify = vi.fn(() => {
      expect(() => sessions.read(session)).toThrow(
        "Connect this secret backend again.",
      );
      expect(detach).toHaveBeenCalledOnce();
      expect(secretBackendSessionClosure(session)).toBe("provider-ended");
      sessions.remove(session);
    });
    signalOf(session).addEventListener("abort", notify);
    const reason = new Error("private-native-reason-credential");
    native.abort(reason);
    expect(notify).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    });
    expect(detach).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    expect(signalOf(session).reason).not.toBe(reason);
    expect(signalOf(session).reason.name).toBe("AbortError");
    expect(String(signalOf(session).reason)).not.toContain(reason.message);
    expect(JSON.stringify(session)).not.toContain(reason.message);
    sessions.remove(session);
    expect(secretBackendSessionClosure(session)).toBe("provider-ended");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("local removal is idempotent and never relays later native reasons", () => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const native = new AbortController();
    const detach = vi.spyOn(native.signal, "removeEventListener");
    const session = sessions.create({}, native.signal);
    const notify = vi.fn(() => {
      expect(() => sessions.read(session)).toThrow();
      expect(secretBackendSessionClosure(session)).toBe("removed");
    });
    signalOf(session).addEventListener("abort", notify);
    sessions.remove(session);
    sessions.remove(session);
    native.abort({ credential: "private-reason" });
    expect(secretBackendSessionClosure(session)).toBe("removed");
    expect(notify).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    expect(signalOf(session).reason.name).toBe("AbortError");
    expect(JSON.stringify(signalOf(session).reason)).not.toContain(
      "private-reason",
    );
  });

  it("cannot read authority from an earlier native abort listener", () => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const native = new AbortController();
    const earlier = vi.fn(() => {
      expect(secretBackendSessionClosure(session)).toBeNull();
      expect(signalOf(session).aborted).toBe(false);
      expect(() => sessions.read(session)).toThrow(
        "Connect this secret backend again.",
      );
      expect(signalOf(session).aborted).toBe(true);
      expect(secretBackendSessionClosure(session)).toBe("provider-ended");
    });
    native.signal.addEventListener("abort", earlier);
    const detach = vi.spyOn(native.signal, "removeEventListener");
    const session = sessions.create({}, native.signal);
    const notify = vi.fn();
    signalOf(session).addEventListener("abort", notify);
    native.abort("private native reason");
    expect(earlier).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    sessions.remove(session);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("rejects an already-ended native lifetime without attaching any listener", () => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const native = new AbortController();
    native.abort("private-ended-reason");
    const add = vi.spyOn(native.signal, "addEventListener");
    expect(() => sessions.create({}, native.signal)).toThrow(
      "Connect this secret backend again.",
    );
    expect(add).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])(
    "refuses native abort %s listener installation and cleans it up",
    (timing) => {
      const sessions = createSecretBackendSessions<object>("fixture");
      const native = new AbortController();
      const original = native.signal.addEventListener.bind(native.signal);
      const detach = vi.spyOn(native.signal, "removeEventListener");
      vi.spyOn(native.signal, "addEventListener").mockImplementation(
        (type, listener, options) => {
          if (timing === "before") native.abort("private-subscribe-reason");
          original(type, listener, options);
          if (timing === "after") native.abort("private-subscribe-reason");
        },
      );
      const allocated = vi.spyOn(Object, "freeze");
      expect(() => sessions.create({}, native.signal)).toThrow(
        "Connect this secret backend again.",
      );
      const session = originalSession.parse(allocated.mock.calls[0]?.[0]);
      allocated.mockRestore();
      expect(secretBackendSessionClosure(session)).toBe("provider-ended");
      expect(signalOf(session).reason.name).toBe("AbortError");
      expect(detach).toHaveBeenCalledOnce();
    },
  );

  it("cleans a listener installed by a throwing subscription without exposing its error", () => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const native = new AbortController();
    const original = native.signal.addEventListener.bind(native.signal);
    const detach = vi.spyOn(native.signal, "removeEventListener");
    vi.spyOn(native.signal, "addEventListener").mockImplementation(
      (type, listener, options) => {
        original(type, listener, options);
        throw new Error("private-subscription-credential");
      },
    );
    const allocated = vi.spyOn(Object, "freeze");
    expect(() => sessions.create({}, native.signal)).toThrow(
      "Connect this secret backend again.",
    );
    const session = originalSession.parse(allocated.mock.calls[0]?.[0]);
    allocated.mockRestore();
    expect(secretBackendSessionClosure(session)).toBe("provider-ended");
    expect(signalOf(session).reason.name).toBe("AbortError");
    expect(detach).toHaveBeenCalledOnce();
    native.abort();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("does not authorize or revoke copied IDs, attached signals or another registry", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const sessions = createSecretBackendSessions<{ token: string }>("fixture");
    const other = createSecretBackendSessions<{ token: string }>("fixture");
    const session = sessions.create({ token: "original" });
    const foreign = other.create({ token: "foreign" });
    const forged = { ...session, signal: signalOf(session) };
    expect(secretBackendSessionClosure(forged)).toBeNull();
    expect(secretBackendSessionClosure({ ...session })).toBeNull();
    expect(foreign.id).toBe(session.id);
    expect(() => sessions.read(forged)).toThrow();
    expect(() => sessions.read(foreign)).toThrow();
    expect(() => other.read(session)).toThrow();
    sessions.remove(forged);
    sessions.remove(foreign);
    other.remove(session);
    expect(secretBackendSessionClosure(session)).toBeNull();
    expect(secretBackendSessionClosure(foreign)).toBeNull();
    expect(sessions.read(session).token).toBe("original");
    expect(other.read(foreign).token).toBe("foreign");
    expect(signalOf(session).aborted).toBe(false);
    expect(signalOf(foreign).aborted).toBe(false);
    sessions.remove(session);
    expect(secretBackendSessionClosure(session)).toBe("removed");
    expect(secretBackendSessionClosure(forged)).toBeNull();
    expect(secretBackendSessionClosure(foreign)).toBeNull();
  });

  it("keeps a replacement session live when the old lifetime ends or listeners reenter", () => {
    const sessions = createSecretBackendSessions<{ generation: number }>(
      "fixture",
    );
    const native = new AbortController();
    const old = sessions.create({ generation: 1 }, native.signal);
    const next = sessions.create({ generation: 2 });
    expect(signalOf(old)).not.toBe(signalOf(next));
    const notify = vi.fn(() => {
      expect(() => sessions.read(old)).toThrow();
      sessions.remove(old);
      expect(sessions.read(next).generation).toBe(2);
    });
    signalOf(old).addEventListener("abort", notify);
    native.abort();
    sessions.remove(old);
    expect(secretBackendSessionClosure(old)).toBe("provider-ended");
    expect(secretBackendSessionClosure(next)).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    expect(signalOf(next).aborted).toBe(false);
    expect(sessions.read(next).generation).toBe(2);
  });

  it("classifies an earlier native listener's remove as provider loss before public notification", () => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const native = new AbortController();
    const earlier = vi.fn(() => sessions.remove(session));
    native.signal.addEventListener("abort", earlier);
    const session = sessions.create({}, native.signal);
    const observer = vi.fn(() => {
      expect(secretBackendSessionClosure(session)).toBe("provider-ended");
      expect(() => sessions.read(session)).toThrow();
      expect(signalOf(session).reason.name).toBe("AbortError");
    });
    signalOf(session).addEventListener("abort", observer);
    native.abort({ secret: "must never become closure metadata" });
    expect(observer).toHaveBeenCalledOnce();
    expect(earlier).toHaveBeenCalledOnce();
    expect(secretBackendSessionClosure(session)).toBe("provider-ended");
  });

  it.each(["removed", "provider-ended"] as const)(
    "keeps the first real %s classification immutable",
    (first) => {
      const sessions = createSecretBackendSessions<object>("fixture");
      const other = createSecretBackendSessions<object>("fixture");
      const native = new AbortController();
      const session = sessions.create({}, native.signal);
      if (first === "removed") sessions.remove(session);
      else native.abort("private provider detail");
      other.remove(session);
      sessions.remove({ ...session, signal: signalOf(session) });
      sessions.remove(session);
      native.abort("later private provider detail");
      expect(secretBackendSessionClosure(session)).toBe(first);
      expect(signalOf(session).reason.name).toBe("AbortError");
      expect(JSON.stringify(session)).not.toContain(first);
      expect(JSON.stringify(signalOf(session).reason)).not.toContain(
        "private provider detail",
      );
    },
  );

  it("returns no metadata for an unknown legacy handle even after its supplied signal aborts", () => {
    const supplied = new AbortController();
    const legacy = {
      id: "legacy",
      backendId: "fixture",
      authenticatedAt: "",
      signal: supplied.signal,
    };
    expect(secretBackendSessionClosure(legacy)).toBeNull();
    supplied.abort({ secret: "untrusted native reason" });
    expect(secretBackendSessionClosure(legacy)).toBeNull();
    expect(supplied.signal.reason).toEqual({
      secret: "untrusted native reason",
    });
  });

  it("admits a new handle inside a terminal observer without the old removal touching it", () => {
    const sessions = createSecretBackendSessions<object>("fixture");
    const original = sessions.create({});
    let replacement: SecretBackendSession | undefined;
    signalOf(original).addEventListener("abort", () => {
      expect(() => sessions.read(original)).toThrow();
      replacement = sessions.create({});
      sessions.remove(original);
    });
    sessions.remove(original);
    if (!replacement)
      throw new Error("Terminal observer did not create its new handle");
    expect(sessions.read(replacement)).toEqual({});
    expect(signalOf(replacement).aborted).toBe(false);
  });
});
