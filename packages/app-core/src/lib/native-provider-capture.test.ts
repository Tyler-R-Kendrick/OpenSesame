import { afterEach, expect, it } from "vitest";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
  captureNativeProviderAuthority,
  nativeProviderTransport,
} from "./native-connector-transport.js";
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});
function port(): NativeProviderTransport {
  return {
    fetch: async () => {
      throw new Error("No test network operation");
    },
    assertCurrent() {},
  };
}
it("preserves the exact existing transport when no networking capture is configured", () => {
  const original = port();
  releases.push(bindNativeProviderTransport(original));
  expect(nativeProviderTransport()).toBe(original);
});
it("captures once per acquisition and a previous session keeps its exact original authority", () => {
  const first = port();
  const second = port();
  let next = first;
  let count = 0;
  const original = {
    ...port(),
    capture: () => {
      count++;
      return next;
    },
  };
  releases.push(bindNativeProviderTransport(original));
  const captured = nativeProviderTransport();
  next = second;
  expect(captured).toBe(first);
  expect(count).toBe(1);
  expect(nativeProviderTransport()).toBe(second);
  expect(count).toBe(2);
  expect(captured).toBe(first);
});
it("refuses a factory that replaced the activation reentrantly", () => {
  const replacement = port();
  const original = {
    ...port(),
    capture: () => {
      releases.push(bindNativeProviderTransport(replacement));
      return port();
    },
  };
  releases.push(bindNativeProviderTransport(original));
  expect(() => nativeProviderTransport()).toThrow("changed during capture");
  expect(nativeProviderTransport()).toBe(replacement);
});
it("refuses either original or captured withdrawal during acquisition", () => {
  let active = true;
  const original = {
    ...port(),
    assertCurrent() {
      if (!active) throw new Error("original ended");
    },
    capture: () => {
      active = false;
      return port();
    },
  };
  releases.push(bindNativeProviderTransport(original));
  expect(() => nativeProviderTransport()).toThrow("original ended");
  const captured = {
    ...port(),
    assertCurrent() {
      throw new Error("node ended");
    },
  };
  releases.push(
    bindNativeProviderTransport({ ...port(), capture: () => captured }),
  );
  expect(() => nativeProviderTransport()).toThrow("node ended");
});

it("binds the original authority without acquiring a route until each explicit operation", () => {
  const first = { ...port(), signal: new AbortController().signal };
  const second = { ...port(), signal: new AbortController().signal };
  let next = first;
  let captures = 0;
  const original = {
    ...port(),
    assertCurrent(this: NativeProviderTransport) {
      expect(this).toBe(original);
    },
    capture(this: NativeProviderTransport) {
      expect(this).toBe(original);
      captures++;
      return next;
    },
  };
  releases.push(bindNativeProviderTransport(original));
  const authority = captureNativeProviderAuthority();
  expect(captures).toBe(0);
  const pending = authority.capture();
  next = second;
  expect(pending.signal).toBe(first.signal);
  expect(authority.capture().signal).toBe(second.signal);
  expect(pending.signal).toBe(first.signal);
  expect(captures).toBe(2);
});
it.each([
  "assertCurrent",
  "capture",
  "fetch",
  "signal",
  "openWebSocket",
  "supportsNativeOrigin",
  "settleCredentialMutation",
])(
  "refuses changed original %s even when the registration object is unchanged",
  (key) => {
    const original = port();
    releases.push(bindNativeProviderTransport(original));
    const authority = captureNativeProviderAuthority();
    const snapshot = authority.capture();
    Object.defineProperty(original, key, {
      value: key === "signal" ? new AbortController().signal : () => undefined,
    });
    expect(snapshot.assertCurrent).toThrow("changed during capture");
    expect(authority.assertCurrent).toThrow("changed during capture");
    expect(authority.capture).toThrow("changed during capture");
  },
);
it("never borrows a later registration and rejects captured-port reentrancy", () => {
  const original = port();
  releases.push(bindNativeProviderTransport(original));
  const authority = captureNativeProviderAuthority();
  const replacement = port();
  releases.push(bindNativeProviderTransport(replacement));
  expect(authority.capture).toThrow("changed during capture");
  expect(nativeProviderTransport()).toBe(replacement);
  releases.push(
    bindNativeProviderTransport({
      ...port(),
      capture: () => ({
        ...port(),
        assertCurrent() {
          releases.push(bindNativeProviderTransport(replacement));
        },
      }),
    }),
  );
  expect(captureNativeProviderAuthority().capture).toThrow(
    "changed during capture",
  );
});
it("preserves an already submitted credential mutation after withdrawal", async () => {
  const lifetime = new AbortController();
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const settling = async function (this: NativeProviderTransport) {
    expect(this).toBe(captured);
    await held;
    return new Response("settled");
  };
  const captured = { ...port(), settleCredentialMutation: settling };
  const original = {
    ...port(),
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    capture: () => captured,
  };
  releases.push(bindNativeProviderTransport(original));
  const authority = captureNativeProviderAuthority();
  const snapshot = authority.capture();
  const pending = snapshot.settleCredentialMutation?.(
    "https://api.example.test/mint",
  );
  lifetime.abort();
  expect(authority.capture).toThrow();
  expect(snapshot.assertCurrent).toThrow();
  finish();
  expect(await (await pending)?.text()).toBe("settled");
});

it("captures prototype methods with their original receiver", async () => {
  class Provider {
    async fetch(this: Provider) {
      expect(this).toBe(original);
      return new Response("prototype");
    }
    assertCurrent(this: Provider) {
      expect(this).toBe(original);
    }
    capture(this: Provider) {
      expect(this).toBe(original);
      return this;
    }
  }
  const original = new Provider();
  releases.push(bindNativeProviderTransport(original));
  const captured = captureNativeProviderAuthority().capture();
  expect(
    await (await captured.fetch("https://api.example.test/read")).text(),
  ).toBe("prototype");
});

it("refuses reentrant registration replacement during a metadata-only assertion", () => {
  let replace = false;
  const replacement = port();
  const original = {
    ...port(),
    assertCurrent() {
      if (replace) releases.push(bindNativeProviderTransport(replacement));
    },
  };
  releases.push(bindNativeProviderTransport(original));
  const authority = captureNativeProviderAuthority();
  replace = true;
  expect(authority.assertCurrent).toThrow("changed during capture");
});
