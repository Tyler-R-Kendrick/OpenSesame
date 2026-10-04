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

import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { useReceiptsSession } from "./use-receipts-session.js";

const realUseVault = vaultHooksSeams.useVault;

const held: IdentitySession = {
  principalId: "prn_held",
  accessToken: "t",
  issuerOrigin: "x",
};
const originalSession = identityHookSeams.useIdentitySession;

function identityAt(identityApi: string): void {
  saveSettings({ ...loadSettings(), identityApi });
}

function serveAudit() {
  registerDeviceRoutes({
    id: "identity.local-iam",
    routes: { audit: async () => null },
  });
}

beforeEach(() => {
  vaultHooksSeams.useVault = () => ({ ...realUseVault(), tomb: "tomb-a" });
  identityAt("");
  resetDeviceRoutesForTests();
  identityHookSeams.useIdentitySession = () => held;
});

afterEach(() => {
  vaultHooksSeams.useVault = realUseVault;
  cleanup();
  identityAt("");
  resetDeviceRoutesForTests();
  identityHookSeams.useIdentitySession = originalSession;
});

describe("useReceiptsSession", () => {
  it("is null on a device that keeps no audit trail, session or not", () => {
    expect(renderHook(() => useReceiptsSession()).result.current).toBeNull();
  });

  it("is the open vault on a device whose capability serves the trail", () => {
    serveAudit();
    expect(renderHook(() => useReceiptsSession()).result.current).toEqual({
      key: "tomb-a",
    });
  });

  it("needs no session on the device: the vault's trail is read for the vault", () => {
    serveAudit();
    identityHookSeams.useIdentitySession = () => null;
    expect(renderHook(() => useReceiptsSession()).result.current).toEqual({
      key: "tomb-a",
    });
  });

  it("shows the trail when its capability activates after the first render", () => {
    const { result } = renderHook(() => useReceiptsSession());
    expect(result.current).toBeNull();
    act(() => serveAudit());
    expect(result.current).toEqual({ key: "tomb-a" });
  });

  it("goes when the capability leaves", () => {
    serveAudit();
    const { result } = renderHook(() => useReceiptsSession());
    expect(result.current).not.toBeNull();
    act(() => resetDeviceRoutesForTests());
    expect(result.current).toBeNull();
  });

  it("is the session's principal on a remote plane, which is asked for the trail itself", () => {
    identityAt("https://id.example.test");
    expect(renderHook(() => useReceiptsSession()).result.current).toEqual({
      key: "prn_held",
    });
  });

  it("is null on a remote plane with no session to ask with", () => {
    identityAt("https://id.example.test");
    identityHookSeams.useIdentitySession = () => null;
    expect(renderHook(() => useReceiptsSession()).result.current).toBeNull();
  });
});
