import { afterEach, expect, it, vi } from "vitest";
import {
  type SecretBackendTransport,
  bindSecretBackendTransport,
  guardSecretBackendTransport,
  secretBackendTransport,
} from "./transport.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});
function port() {
  const lifetime = new AbortController();
  const transport: SecretBackendTransport = {
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    fetch: vi.fn<typeof fetch>(async () => new Response("owned")),
  };
  return { lifetime, transport };
}

it("captures once and existing backend sessions retain the original transport", () => {
  const original = port();
  const later = port();
  const capture = vi.fn(() => original.transport);
  releases.push(bindSecretBackendTransport({ ...original.transport, capture }));
  const held = secretBackendTransport();
  expect(held).toBe(original.transport);
  expect(capture).toHaveBeenCalledTimes(1);
  releases.push(bindSecretBackendTransport(later.transport));
  expect(held).toBe(original.transport);
  expect(secretBackendTransport()).toBe(later.transport);
  original.lifetime.abort();
  expect(() => held.assertCurrent()).toThrow();
  expect(capture).toHaveBeenCalledTimes(1);
});

it("rejects reentrant activation replacement during capture", () => {
  const original = port();
  const later = port();
  releases.push(
    bindSecretBackendTransport({
      ...original.transport,
      capture: () => {
        releases.push(bindSecretBackendTransport(later.transport));
        return original.transport;
      },
    }),
  );
  expect(() => secretBackendTransport()).toThrow(/changed/);
});

it("forwards only the captured live predicate and refuses owner withdrawal without recapture", () => {
  const original = port();
  const owner = new AbortController();
  let current = true;
  const predicate = vi.fn(
    (origin: string) => origin === "https://secrets.example",
  );
  const capture = vi.fn(() => original.transport);
  const guarded = guardSecretBackendTransport(
    { ...original.transport, capture, supportsNativeOrigin: predicate },
    () => {
      if (!current) throw new Error("retargeted");
    },
    owner.signal,
  );
  expect(guarded.capture).toBeUndefined();
  expect(guarded.supportsNativeOrigin?.("https://secrets.example")).toBe(true);
  expect(guarded.supportsNativeOrigin?.("https://other.example")).toBe(false);
  current = false;
  expect(guarded.supportsNativeOrigin?.("https://secrets.example")).toBe(false);
  current = true;
  owner.abort();
  expect(guarded.signal.aborted).toBe(true);
  expect(guarded.supportsNativeOrigin?.("https://secrets.example")).toBe(false);
  expect(capture).not.toHaveBeenCalled();
  expect(
    guardSecretBackendTransport(original.transport).supportsNativeOrigin,
  ).toBeUndefined();
});
