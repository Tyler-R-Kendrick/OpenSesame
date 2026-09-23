import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBrowserPairing,
  browserPairingSeams,
  clearBrowserPairing,
  currentBrowserGrant,
  pairedHostFetch,
  pollBrowserPairing,
} from "./browser-pairing.js";
import { localNetworkFetchSeams } from "./local-network-fetch.js";

const host = "http://127.0.0.1:8787";
const token = "test-only-opaque-credential-with-at-least-32-bytes";
const proof = vi.fn(async () => "test-proof");
const eligible = browserPairingSeams.eligible;
const createKey = browserPairingSeams.createKey;
const networkEligible = localNetworkFetchSeams.eligible;
const pairing = {
  pairing_id: "pairing-1",
  device_code: "d".repeat(40),
  user_code: "ABCD-1234",
  verification_uri: `${host}/pair`,
  expires_in: 300,
  interval: 5,
};
const issued = {
  access_token: token,
  token_type: "DPoP",
  expires_in: 300,
  client_id: "client-1",
  scope: "host.sync.read host.sync.write",
};

beforeEach(() => {
  clearBrowserPairing();
  proof.mockClear();
  browserPairingSeams.eligible = () => true;
  localNetworkFetchSeams.eligible = () => true;
  browserPairingSeams.createKey = async () => ({
    createDpopProof: proof,
    jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  });
});
afterEach(() => {
  clearBrowserPairing();
  browserPairingSeams.eligible = eligible;
  browserPairingSeams.createKey = createKey;
  localNetworkFetchSeams.eligible = networkEligible;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("explicit browser authority", () => {
  it("does not bootstrap authority when an ordinary Host request is attempted", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      pairedHostFetch(host, "/api/v1/sync/pull-page"),
    ).rejects.toMatchObject({ code: "pairing_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses shared-origin pairing before generating a key or sending requests", async () => {
    browserPairingSeams.eligible = () => false;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(beginBrowserPairing(host)).rejects.toMatchObject({
      code: "restricted_demo",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps credentials private and binds every request to its token, method and URL", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(pairing))
      .mockResolvedValueOnce(Response.json(issued))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const prompt = await beginBrowserPairing(host);
    expect(JSON.stringify(prompt)).not.toContain(pairing.device_code);
    const grant = await pollBrowserPairing();
    expect(JSON.stringify(grant)).not.toContain(token);
    await pairedHostFetch(host, "/api/v1/sync/pull-page", {
      method: "POST",
      body: "{}",
    });
    const request = fetcher.mock.calls[2][1];
    expect(request.headers.get("Authorization")).toBe(`DPoP ${token}`);
    expect(request.headers.has("X-OpenSesame-Operator")).toBe(false);
    expect(request.credentials).toBe("omit");
    expect(request.redirect).toBe("error");
    expect(proof).toHaveBeenLastCalledWith(
      `${host}/api/v1/sync/pull-page`,
      "POST",
      token,
    );
    clearBrowserPairing();
    expect(currentBrowserGrant(host)).toBeNull();
  });
  it.each([
    { ...issued, token_type: "Bearer" },
    { ...issued, access_token: "" },
    { ...issued, scope: "host.admin" },
    { ...issued, expires_in: 301 },
  ])("rejects an invalid or broader token response", async (response) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(pairing))
        .mockResolvedValueOnce(Response.json(response)),
    );
    await beginBrowserPairing(host);
    await expect(pollBrowserPairing()).rejects.toMatchObject({
      code: "pairing_failed",
    });
    expect(currentBrowserGrant(host)).toBeNull();
  });
  it("cannot restore a grant after lock races a pending token request", async () => {
    let release = (_value: Response) => {};
    const waiting = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(pairing))
        .mockReturnValueOnce(waiting),
    );
    await beginBrowserPairing(host);
    const poll = pollBrowserPairing();
    await Promise.resolve();
    clearBrowserPairing();
    release(Response.json(issued));
    await expect(poll).rejects.toMatchObject({ code: "pairing_expired" });
    expect(currentBrowserGrant(host)).toBeNull();
  });
  it("does not create a remote pairing after cleanup races key generation", async () => {
    const key = await browserPairingSeams.createKey();
    let release = () => {};
    browserPairingSeams.createKey = () =>
      new Promise((resolve) => {
        release = () => resolve(key);
      });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const beginning = beginBrowserPairing(host);
    clearBrowserPairing();
    release();
    await expect(beginning).rejects.toMatchObject({ code: "pairing_expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not send a pairing request after cleanup races proof creation", async () => {
    let release = () => {};
    proof.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve("abandoned-proof");
        }),
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const beginning = beginBrowserPairing(host);
    await Promise.resolve();
    clearBrowserPairing();
    release();
    await expect(beginning).rejects.toMatchObject({ code: "pairing_expired" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("aborts an in-flight request and refuses its response after lock", async () => {
    let release = (_response: Response) => {};
    const waiting = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(pairing))
      .mockResolvedValueOnce(Response.json(issued))
      .mockReturnValueOnce(waiting);
    vi.stubGlobal("fetch", fetcher);
    await beginBrowserPairing(host);
    await pollBrowserPairing();
    const request = pairedHostFetch(host, "/api/v1/sync/pull-page");
    await Promise.resolve();
    const signal = fetcher.mock.calls[2][1].signal;
    clearBrowserPairing();
    expect(signal.aborted).toBe(true);
    release(Response.json({ ok: true }));
    await expect(request).rejects.toMatchObject({ code: "pairing_expired" });
  });
});
