/** @vitest-environment jsdom */
import {
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "@opensesame/app-core/lib/device-identity-routes.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useIdentityConfigured,
  useIdentityPlane,
  useIdentityServes,
} from "./use-configured.js";

function identityAt(identityApi: string): void {
  saveSettings({ ...loadSettings(), identityApi });
}

beforeEach(() => {
  identityAt("");
  resetDeviceRoutesForTests();
});

afterEach(() => {
  cleanup();
  identityAt("");
  resetDeviceRoutesForTests();
});

describe("useIdentityPlane", () => {
  it("is the device with no Identity address, and follows Settings to a remote", () => {
    const { result } = renderHook(() => useIdentityPlane());
    expect(result.current).toBe("device");
    act(() => identityAt("https://id.example.test"));
    expect(result.current).toBe("remote");
    act(() => identityAt(""));
    expect(result.current).toBe("device");
  });
});

describe("useIdentityServes", () => {
  it("serves a session on the device, and a family only once it is registered", () => {
    const session = renderHook(() => useIdentityServes("session"));
    const directory = renderHook(() => useIdentityServes("directory"));
    expect(session.result.current).toBe(true);
    expect(directory.result.current).toBe(false);
    registerDeviceRoutes({
      id: "identity.local-iam",
      routes: { directory: async () => null },
    });
    expect(
      renderHook(() => useIdentityServes("directory")).result.current,
    ).toBe(true);
  });

  it("never serves what needs a server on the device, and does on a remote", () => {
    const codes = renderHook(() => useIdentityServes("mfa-codes"));
    expect(codes.result.current).toBe(false);
    act(() => identityAt("https://id.example.test"));
    expect(codes.result.current).toBe(true);
  });
});

describe("useIdentityServes, late", () => {
  it("re-reads when a capability registers after the panel drew, and when it leaves", () => {
    const { result } = renderHook(() => useIdentityServes("audit"));
    expect(result.current).toBe(false);
    let off = () => {};
    act(() => {
      off = registerDeviceRoutes({
        id: "identity.local-iam",
        routes: { audit: async () => null },
      });
    });
    expect(result.current).toBe(true);
    act(() => off());
    expect(result.current).toBe(false);
  });
});

describe("useIdentityConfigured", () => {
  it("still means only that a remote address is set", () => {
    const { result } = renderHook(() => useIdentityConfigured());
    expect(result.current).toBe(false);
    act(() => identityAt("https://id.example.test"));
    expect(result.current).toBe(true);
  });
});
