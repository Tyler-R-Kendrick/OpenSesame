/**
 * A join sitting's renewal never brings a grant back that sign-out cleared
 * while the renewal was in flight (ADR 0136 §2), and a grant lapses with its
 * token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBrowserPairing,
  browserPairingSeams,
  clearBrowserPairing,
  currentBrowserGrant,
  pollBrowserPairing,
  renewBrowserGrant,
} from "./browser-pairing.js";
import { identitySeams } from "./identity.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";

const host = "http://127.0.0.1:8787";
const token = "test-only-opaque-credential-with-at-least-32-bytes";
const renewedToken = "renewed-opaque-credential-with-at-least-32-bytes!";
const eligible = browserPairingSeams.eligible;
const createKey = browserPairingSeams.createKey;
const networkEligible = localNetworkFetchSeams.eligible;
const originalIdentity = { ...identitySeams };
const pairing = {
  pairing_id: "pairing-1",
  device_code: "d".repeat(40),
  user_code: "ABCD-1234",
  verification_uri: `${host}/pair`,
  expires_in: 300,
  interval: 5,
};

function issued(scope: string, accessToken = token) {
  return {
    access_token: accessToken,
    token_type: "DPoP",
    expires_in: 60,
    client_id: "client-1",
    scope,
  };
}

async function approve(scope: string, ceiling: "sync" | "join" = "sync") {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(pairing))
      .mockResolvedValueOnce(Response.json(issued(scope))),
  );
  await beginBrowserPairing(host, ceiling);
  await pollBrowserPairing();
}

beforeEach(() => {
  clearBrowserPairing();
  browserPairingSeams.eligible = () => true;
  localNetworkFetchSeams.eligible = () => true;
  browserPairingSeams.createKey = async () => ({
    createDpopProof: async () => "test-proof",
    jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  });
  identitySeams.hostBase = () => host;
});

afterEach(() => {
  clearBrowserPairing();
  browserPairingSeams.eligible = eligible;
  browserPairingSeams.createKey = createKey;
  localNetworkFetchSeams.eligible = networkEligible;
  Object.assign(identitySeams, originalIdentity);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renewing a join sitting", () => {
  it("renews to the same client with a fresh token and the same ceiling", async () => {
    await approve("host.join", "join");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(issued("host.join", renewedToken)),
        ),
    );
    expect(await renewBrowserGrant(host)).toBe(true);
    expect(currentBrowserGrant(host)?.capabilities).toEqual(["host.join"]);
  });

  it("does not bring a cleared grant back when sign-out lands while the renewal is read", async () => {
    await approve("host.join", "join");
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchMock);
    const renewing = renewBrowserGrant(host);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    clearBrowserPairing();
    stream?.enqueue(
      new TextEncoder().encode(
        JSON.stringify(issued("host.join", renewedToken)),
      ),
    );
    stream?.close();
    expect(await renewing).toBe(false);
    expect(currentBrowserGrant(host)).toBeNull();
  });
});

describe("a held grant", () => {
  it("lapses with its token", async () => {
    await approve("host.sync.read");
    expect(currentBrowserGrant(host)).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(currentBrowserGrant(host)).toBeNull();
  });
});
