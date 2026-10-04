/** @vitest-environment jsdom */
import {
  registerDeviceRoutes,
  resetDeviceRoutesForTests,
} from "@opensesame/app-core/lib/device-identity-routes.js";
import type { IdentitySession } from "@opensesame/app-core/lib/identity.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { useReceiptsSession } from "./use-receipts-session.js";

const held: IdentitySession = {
  principalId: "prn_held",
  accessToken: "t",
  issuerOrigin: "x",
};
const originalSession = identityHookSeams.useIdentitySession;

function identityAt(identityApi: string): void {
  saveSettings({ ...loadSettings(), identityApi });
}

beforeEach(() => {
  identityAt("");
  resetDeviceRoutesForTests();
  identityHookSeams.useIdentitySession = () => held;
});

afterEach(() => {
  cleanup();
  identityAt("");
  resetDeviceRoutesForTests();
  identityHookSeams.useIdentitySession = originalSession;
});

describe("useReceiptsSession", () => {
  it("is null on a device that keeps no audit trail, session or not", () => {
    expect(renderHook(() => useReceiptsSession()).result.current).toBeNull();
  });

  it("is the session on a device whose capability serves the trail", () => {
    registerDeviceRoutes({
      id: "identity.local-iam",
      routes: { audit: async () => null },
    });
    expect(renderHook(() => useReceiptsSession()).result.current).toBe(held);
  });

  it("shows the session when the trail's capability activates after the first render", () => {
    const { result } = renderHook(() => useReceiptsSession());
    expect(result.current).toBeNull();
    act(() => {
      registerDeviceRoutes({
        id: "identity.local-iam",
        routes: { audit: async () => null },
      });
    });
    expect(result.current).toBe(held);
  });

  it("is null with no session even where the trail is served", () => {
    registerDeviceRoutes({
      id: "identity.local-iam",
      routes: { audit: async () => null },
    });
    identityHookSeams.useIdentitySession = () => null;
    expect(renderHook(() => useReceiptsSession()).result.current).toBeNull();
  });

  it("is the session on a remote plane, which is asked for the trail itself", () => {
    identityAt("https://id.example.test");
    expect(renderHook(() => useReceiptsSession()).result.current).toBe(held);
  });
});
