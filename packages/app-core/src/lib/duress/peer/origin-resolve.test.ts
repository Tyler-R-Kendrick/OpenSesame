import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHost, configureHost, host } from "../../../host.js";
import type { PeerEnvelope } from "./envelope.js";
import { assertPeerOriginResolved } from "./origin-resolve.js";
import { sendPeerEnvelope } from "./sender.js";

const PUBLIC = "8.8.8.8";

function installLookup(
  lookup: (hostname: string) => Promise<readonly string[]>,
): () => void {
  const previous = host();
  configureHost(
    composeHost(previous, { env: previous.env, peerDns: { lookup } }),
  );
  return () => configureHost(previous);
}

describe("peer origin DNS policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts an address literal without resolving it", async () => {
    const lookup = vi.fn(async () => [PUBLIC]);
    await expect(
      assertPeerOriginResolved("http://127.0.0.1:8787", lookup),
    ).resolves.toMatchObject({ hostname: "127.0.0.1" });
    await expect(
      assertPeerOriginResolved("https://[2606:4700:4700::1111]", lookup),
    ).resolves.toMatchObject({ hostname: "[2606:4700:4700::1111]" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a hostname when this host cannot resolve it", async () => {
    await expect(
      assertPeerOriginResolved("https://peer.example"),
    ).rejects.toThrow(/unapproved_route/);
  });

  it("refuses a name that resolves into a blocked network", async () => {
    const blocked = [
      "10.1.2.3",
      "169.254.169.254",
      "127.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:169.254.169.254",
      "192.168.1.20",
    ];
    for (const address of blocked) {
      await expect(
        assertPeerOriginResolved("https://peer.example", async () => [address]),
        address,
      ).rejects.toThrow(/unapproved_route/);
    }
  });

  it("refuses a mixed answer that includes one blocked address", async () => {
    await expect(
      assertPeerOriginResolved("https://peer.example", async () => [
        PUBLIC,
        "10.0.0.8",
      ]),
    ).rejects.toThrow(/unapproved_route/);
  });

  it("refuses an empty answer and a failed lookup", async () => {
    await expect(
      assertPeerOriginResolved("https://peer.example", async () => []),
    ).rejects.toThrow(/unapproved_route/);
    await expect(
      assertPeerOriginResolved("https://peer.example", async () => {
        throw new Error("servfail");
      }),
    ).rejects.toThrow(/unapproved_route/);
  });

  it("allows a name that resolves only to public addresses", async () => {
    const url = await assertPeerOriginResolved(
      "https://peer.example",
      async () => [PUBLIC, "2606:4700:4700::1111"],
    );
    expect(url.origin).toBe("https://peer.example");
  });

  it("does not fetch a name that resolves to a metadata address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const restore = installLookup(async () => ["169.254.169.254"]);
    await expect(
      sendPeerEnvelope({ audience: "receiver-1" } as PeerEnvelope, {
        registeredOrigin: "https://rebind.example",
        audience: "receiver-1",
        recipientPublicKey: {} as CryptoKey,
      }),
    ).rejects.toThrow(/unapproved_route/);
    expect(fetchMock).not.toHaveBeenCalled();
    restore();
  });
});
