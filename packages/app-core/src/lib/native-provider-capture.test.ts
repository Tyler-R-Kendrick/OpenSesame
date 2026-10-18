import { afterEach, expect, it } from "vitest";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
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
