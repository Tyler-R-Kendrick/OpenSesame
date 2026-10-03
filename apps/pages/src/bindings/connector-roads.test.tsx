/**
 * The connector roads follow the Host grant: when it is approved, renewed or
 * ended, the tiles and forms that depend on it appear or go (ADR 0151).
 */
/** @vitest-environment jsdom */
import {
  beginBrowserPairing,
  browserPairingSeams,
  clearBrowserPairing,
  pollBrowserPairing,
} from "@opensesame/app-core/lib/browser-pairing.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  HOST_CONNECTIONS_WRITE,
  hostGrantSeams,
} from "@opensesame/app-core/lib/host-grant.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { localNetworkFetchSeams } from "@opensesame/app-core/lib/local-network-fetch.js";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../lib/vault/hooks.js";
import { useConnectorRoads } from "./connector-roads.js";

const host = "http://127.0.0.1:8787";
const originalIdentity = { ...identitySeams };
const originalGrant = { ...hostGrantSeams };
const originalVault = { ...vaultHooksSeams };
const originalPairing = { ...browserPairingSeams };
const originalNetwork = { ...localNetworkFetchSeams };
const held = { capabilities: new Array<string>() };
const authorizeOnly: Pick<Provider, "id" | "authKind"> = {
  id: "slack",
  authKind: "oauth2_authorization_code",
};

async function approveSyncPairing() {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          pairing_id: "pairing-1",
          device_code: "d".repeat(40),
          user_code: "ABCD-1234",
          verification_uri: `${host}/pair`,
          expires_in: 300,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "test-only-opaque-credential-with-at-least-32-bytes",
          token_type: "DPoP",
          expires_in: 60,
          client_id: "client-1",
          scope: "host.sync.read host.sync.write",
        }),
      ),
  );
  await beginBrowserPairing(host, "sync");
  await pollBrowserPairing();
}

beforeEach(() => {
  clearBrowserPairing();
  held.capabilities = [];
  browserPairingSeams.eligible = () => true;
  browserPairingSeams.createKey = async () => ({
    createDpopProof: async () => "test-proof",
    jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  });
  localNetworkFetchSeams.eligible = () => true;
  identitySeams.hostBase = () => host;
  identitySeams.hostLocalSessionEligible = () => true;
  hostGrantSeams.capabilities = () => held.capabilities;
  Object.assign(vaultHooksSeams, {
    useVault: () => ({ status: "locked", guest: false, tomb: "personal" }),
  });
});

afterEach(() => {
  cleanup();
  clearBrowserPairing();
  Object.assign(identitySeams, originalIdentity);
  Object.assign(hostGrantSeams, originalGrant);
  Object.assign(vaultHooksSeams, originalVault);
  Object.assign(browserPairingSeams, originalPairing);
  Object.assign(localNetworkFetchSeams, originalNetwork);
  vi.unstubAllGlobals();
});

describe("connector roads and the Host grant", () => {
  it("offers a Host-only form once the grant arrives, and withdraws it when the grant ends", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConnectorRoads();
    });
    expect(result.current.form(authorizeOnly)).toBeNull();
    expect(result.current.acts(authorizeOnly)).toBe(false);

    // A reader only redraws if it was told: the readers are plain functions.
    let seen = renders;
    held.capabilities = [HOST_CONNECTIONS_WRITE];
    await act(async () => {
      await approveSyncPairing();
    });
    expect(renders).toBeGreaterThan(seen);
    expect(result.current.form(authorizeOnly)).toBe("host");
    expect(result.current.acts(authorizeOnly)).toBe(true);

    seen = renders;
    held.capabilities = [];
    await act(async () => {
      clearBrowserPairing();
    });
    expect(renders).toBeGreaterThan(seen);
    expect(result.current.form(authorizeOnly)).toBeNull();
    expect(result.current.acts(authorizeOnly)).toBe(false);
  });

  it("keeps a grant that only syncs from opening the form", async () => {
    const { result } = renderHook(() => useConnectorRoads());
    held.capabilities = ["host.sync.read", "host.sync.write"];
    await act(async () => {
      await approveSyncPairing();
    });
    expect(result.current.form(authorizeOnly)).toBeNull();
    expect(result.current.acts(authorizeOnly)).toBe(false);
  });
});
