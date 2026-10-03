/**
 * The held Host grant is state the pages draw from: a change to it is
 * announced, and what it carries decides which connector roads are open
 * (ADR 0151).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBrowserPairing,
  browserGrantEpoch,
  browserPairingSeams,
  clearBrowserPairing,
  currentBrowserGrant,
  pollBrowserPairing,
  renewBrowserGrant,
  subscribeBrowserGrant,
} from "./browser-pairing.js";
import { HOST_CONNECTIONS_WRITE, hostGrantAllows } from "./host-grant.js";
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

/** Listeners run on a microtask, so a test lets it settle before it looks. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
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

describe("announcing a change to the held grant", () => {
  it("tells a subscriber when a pairing is approved", async () => {
    const listener = vi.fn();
    const stop = subscribeBrowserGrant(listener);
    const before = browserGrantEpoch();
    await approve("host.sync.read host.sync.write");
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(browserGrantEpoch()).toBeGreaterThan(before);
    stop();
  });

  it("tells a subscriber when the grant ends, and not when none was held", async () => {
    const listener = vi.fn();
    const stop = subscribeBrowserGrant(listener);
    clearBrowserPairing();
    await settle();
    expect(listener).not.toHaveBeenCalled();
    await approve("host.sync.read");
    await settle();
    listener.mockClear();
    clearBrowserPairing();
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("tells a subscriber when a join sitting is renewed", async () => {
    await approve("host.join", "join");
    await settle();
    const listener = vi.fn();
    const stop = subscribeBrowserGrant(listener);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(issued("host.join", renewedToken)),
        ),
    );
    expect(await renewBrowserGrant(host)).toBe(true);
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not bring a cleared grant back when sign-out lands while the renewal is read", async () => {
    await approve("host.join", "join");
    await settle();
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
    await settle();
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

  it("tells a subscriber when the grant lapses, with nothing asking about it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await approve("host.sync.read");
    const listener = vi.fn();
    const stop = subscribeBrowserGrant(listener);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(currentBrowserGrant(host)).toBeNull();
    stop();
  });

  it("stops telling a subscriber that has unsubscribed", async () => {
    const listener = vi.fn();
    subscribeBrowserGrant(listener)();
    await approve("host.sync.read");
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("what the held grant carries", () => {
  it("allows nothing with no grant", () => {
    expect(hostGrantAllows(HOST_CONNECTIONS_WRITE)).toBe(false);
  });

  it("allows nothing with no Host named, whatever grant is held", async () => {
    await approve("host.sync.read");
    identitySeams.hostBase = () => "";
    expect(hostGrantAllows("host.sync.read")).toBe(false);
  });

  it("a sync grant allows sync and not connection writes", async () => {
    await approve("host.sync.read host.sync.write");
    expect(hostGrantAllows("host.sync.read")).toBe(true);
    expect(hostGrantAllows(HOST_CONNECTIONS_WRITE)).toBe(false);
  });

  it("a join grant allows joining and not connection writes", async () => {
    await approve("host.join", "join");
    expect(hostGrantAllows("host.join")).toBe(true);
    expect(hostGrantAllows(HOST_CONNECTIONS_WRITE)).toBe(false);
  });

  it("the capability is no longer allowed once the grant ends", async () => {
    await approve("host.sync.read");
    expect(hostGrantAllows("host.sync.read")).toBe(true);
    clearBrowserPairing();
    expect(hostGrantAllows("host.sync.read")).toBe(false);
  });
});
