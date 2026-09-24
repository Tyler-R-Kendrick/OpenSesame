// @vitest-environment jsdom
/**
 * The findings a deep review of the join road raised (ADR 0136), each held
 * down: a join pairing's narrow ceiling, the device-wide "already opened"
 * marker, lists never cut silently, invisible characters, the Host's own
 * character count, and an address bar that loses only the invite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginBrowserPairing,
  browserPairingSeams,
  clearBrowserPairing,
  currentBrowserGrant,
  pairedHostFetch,
  pollBrowserPairing,
  renewBrowserGrant,
} from "../browser-pairing.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { listNotices } from "../notices.js";
import {
  JoinError,
  askToJoin,
  joinSeams,
  keepJoinAuthority,
  verifyAt,
} from "./client.js";
import {
  captureInviteFromPage,
  noteLength,
  onInviteArrival,
  resetCapturedInviteForTests,
  takeCapturedInvite,
  watchInviteArrivals,
} from "./invite.js";
import { forgetPresented, markPresented, wasPresented } from "./presented.js";
import { readPendingJoin, writePendingJoin } from "./stash.js";
import { readOffer, safeText } from "./wire.js";

const TOKEN = `osc_dlg_dlgo_${"a".repeat(32)}.${"B".repeat(43)}`;
const HOST = "http://127.0.0.1:8787";
const SESSION = "session:0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const originalJoin = { ...joinSeams };
const originalPairing = { ...browserPairingSeams };
const networkEligible = localNetworkFetchSeams.eligible;

function offerWith(actions: string[]) {
  return {
    offer: {
      id: "dlgo_1",
      manifest_digest: "sha256:ab",
      expires_at: null,
      items: [
        {
          id: "i1",
          display_name: "GitHub",
          provider_id: "github",
          actions,
          resources: [],
          expires_in_seconds: 7200,
          required: true,
          dependencies: [],
        },
      ],
    },
  };
}

afterEach(() => {
  Object.assign(joinSeams, originalJoin);
  Object.assign(browserPairingSeams, originalPairing);
  localNetworkFetchSeams.eligible = networkEligible;
  clearBrowserPairing();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("a join pairing asks for the join and nothing else", () => {
  beforeEach(() => {
    browserPairingSeams.eligible = () => true;
    localNetworkFetchSeams.eligible = () => true;
    browserPairingSeams.createKey = async () => ({
      createDpopProof: async () => "proof",
      jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    });
  });

  const prompt = {
    pairing_id: "pairing-1",
    device_code: "d".repeat(40),
    user_code: "ABCD-1234",
    verification_uri: `${HOST}/pair`,
    expires_in: 300,
    interval: 5,
  };
  const issued = (scope: string) => ({
    access_token: "t".repeat(40),
    token_type: "DPoP",
    expires_in: 300,
    client_id: "client-1",
    scope,
  });

  it("requests host.join, and takes a grant of exactly that", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(prompt))
      .mockResolvedValueOnce(Response.json(issued("host.join")));
    vi.stubGlobal("fetch", fetcher);
    await beginBrowserPairing(HOST, "join");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
      capabilities: ["host.join"],
    });
    await pollBrowserPairing();
    expect(currentBrowserGrant(HOST)?.capabilities).toEqual(["host.join"]);
  });

  it("refuses a grant wider than, or other than, what it asked for", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(prompt))
      .mockResolvedValueOnce(Response.json(issued("host.sync.read")));
    vi.stubGlobal("fetch", fetcher);
    await beginBrowserPairing(HOST, "join");
    await expect(pollBrowserPairing()).rejects.toMatchObject({
      code: "pairing_failed",
    });
    expect(currentBrowserGrant(HOST)).toBeNull();
  });

  it("the join client pairs under the join ceiling", async () => {
    const begin = vi.fn(async () => ({
      pairingId: "p",
      userCode: "ABCD-1234",
      verificationUri: `${HOST}/pair`,
      expiresAt: Date.now() + 60_000,
      interval: 5,
    }));
    joinSeams.eligible = () => true;
    joinSeams.beginPairing = begin;
    const { beginApproval } = await import("./client.js");
    await beginApproval(HOST);
    expect(begin).toHaveBeenCalledWith(HOST, "join");
  });
});

describe("a join grant is kept alive while the ceremony is on screen", () => {
  beforeEach(() => {
    browserPairingSeams.eligible = () => true;
    localNetworkFetchSeams.eligible = () => true;
    browserPairingSeams.createKey = async () => ({
      createDpopProof: async () => "proof",
      jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    });
  });

  const token = (access: string, scope = "host.join") => ({
    access_token: access.repeat(40),
    token_type: "DPoP",
    expires_in: 300,
    client_id: "client-1",
    scope,
  });

  async function paired(fetcher: ReturnType<typeof vi.fn>) {
    fetcher
      .mockResolvedValueOnce(
        Response.json({
          pairing_id: "p",
          device_code: "d".repeat(40),
          user_code: "ABCD-1234",
          verification_uri: `${HOST}/pair`,
          expires_in: 300,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(Response.json(token("a")));
    vi.stubGlobal("fetch", fetcher);
    await beginBrowserPairing(HOST, "join");
    await pollBrowserPairing();
  }

  it("renews under the old token, then speaks with the new one", async () => {
    const fetcher = vi.fn();
    await paired(fetcher);
    fetcher.mockResolvedValueOnce(Response.json(token("b")));
    expect(await renewBrowserGrant(HOST)).toBe(true);
    const renewal = fetcher.mock.calls[2];
    expect(renewal?.[0]).toBe(`${HOST}/api/v1/browser-pairings/renew`);
    expect(renewal?.[1].headers.get("Authorization")).toBe(
      `DPoP ${"a".repeat(40)}`,
    );
    fetcher.mockResolvedValueOnce(Response.json({ sessions: [] }));
    await pairedHostFetch(HOST, "/api/v1/shared-sessions?visibility=public");
    expect(fetcher.mock.calls[3]?.[1].headers.get("Authorization")).toBe(
      `DPoP ${"b".repeat(40)}`,
    );
  });

  it("keeps the grant in hand when the sitting is over", async () => {
    const fetcher = vi.fn();
    await paired(fetcher);
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "join_sitting_over" }, { status: 403 }),
    );
    expect(await renewBrowserGrant(HOST)).toBe(false);
    expect(currentBrowserGrant(HOST)?.capabilities).toEqual(["host.join"]);
  });

  it("refuses a renewal wider than the grant it renews", async () => {
    const fetcher = vi.fn();
    await paired(fetcher);
    fetcher.mockResolvedValueOnce(Response.json(token("b", "host.sync.read")));
    await expect(renewBrowserGrant(HOST)).rejects.toMatchObject({
      code: "pairing_failed",
    });
    expect(currentBrowserGrant(HOST)?.capabilities).toEqual(["host.join"]);
  });

  it("renews only near the end, and a failure changes nothing", async () => {
    const renew = vi.fn<typeof joinSeams.renew>(async () => {
      throw new Error("offline");
    });
    joinSeams.renew = renew;
    const expiring = (inMs: number) => () => ({
      clientId: "c",
      hostApi: HOST,
      expiresAt: Date.now() + inMs,
      capabilities: ["host.join"],
    });
    joinSeams.grant = expiring(4 * 60_000);
    await keepJoinAuthority(HOST);
    expect(renew).not.toHaveBeenCalled();
    joinSeams.grant = expiring(60_000);
    await expect(keepJoinAuthority(HOST)).resolves.toBeUndefined();
    expect(renew).toHaveBeenCalledWith(HOST);
    joinSeams.grant = () => null;
    renew.mockClear();
    await keepJoinAuthority(HOST);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe("a refused passkey check says which rung to go back to", () => {
  it("verify again while the grant stands; approval again once it is gone", async () => {
    joinSeams.eligible = () => true;
    joinSeams.identityApi = () => "https://id.example.org";
    let grant: ReturnType<typeof joinSeams.grant> = {
      clientId: "c",
      hostApi: HOST,
      expiresAt: Date.now() + 60_000,
      capabilities: ["host.join"],
    };
    joinSeams.grant = () => grant;
    joinSeams.authorize = async () => {
      throw new Error("refused");
    };
    const signal = new AbortController().signal;
    await expect(verifyAt(HOST, signal)).rejects.toMatchObject({
      code: "verify_failed",
    });
    joinSeams.authorize = async () => {
      grant = null;
      throw new Error("refused, and the 401 ended the grant");
    };
    await expect(verifyAt(HOST, signal)).rejects.toMatchObject({
      code: "approval_expired",
    });
  });
});

describe("this device opens an invite once", () => {
  it("marks a digest, never the bearer, and forgets on request", async () => {
    expect(await wasPresented(TOKEN)).toBe(false);
    await markPresented(TOKEN, null);
    expect(await wasPresented(TOKEN)).toBe(true);
    const stored = localStorage.getItem("join.presented.v1") ?? "";
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain("osc_dlg_");
    await forgetPresented(TOKEN);
    expect(await wasPresented(TOKEN)).toBe(false);
  });

  it("lets the mark lapse with the offer, and never past the Host's ceiling", async () => {
    const now = Date.now();
    await markPresented(TOKEN, now + 60_000, now);
    expect(await wasPresented(TOKEN, now + 59_000)).toBe(true);
    expect(await wasPresented(TOKEN, now + 61_000)).toBe(false);
    await markPresented(TOKEN, now + 90 * 24 * 3_600_000, now);
    expect(await wasPresented(TOKEN, now + 25 * 3_600_000)).toBe(false);
  });

  it("keeps a looked-up offer as long as the offer lives, not half an hour", () => {
    const now = Date.now();
    const offer = {
      ...readOffer(offerWith(["read"])),
      expiresAt: now + 6 * 3_600_000,
    };
    writePendingJoin({ endpoint: HOST, token: TOKEN, offer }, now);
    expect(readPendingJoin(now + 2 * 3_600_000)?.token).toBe(TOKEN);
    expect(readPendingJoin(now + 7 * 3_600_000)).toBeNull();
  });
});

describe("what an offer shows is what it offers", () => {
  it("never cuts a list silently, and no length makes an offer unreadable", () => {
    const many = Array.from({ length: 1000 }, (_, at) => `op.${at}`);
    const item = readOffer(offerWith(many)).items[0];
    expect(item?.actions.shown).toHaveLength(16);
    expect(item?.actions.more).toBe(984);
    expect(item?.lifetime).toBe(7200);
  });

  it("carries the unshown count through the tab's stash", () => {
    const many = Array.from({ length: 20 }, (_, at) => `op.${at}`);
    const offer = readOffer(offerWith(many));
    writePendingJoin({ endpoint: HOST, token: TOKEN, offer });
    expect(readPendingJoin()?.offer.items[0]?.actions.more).toBe(4);
  });

  it("drops characters that change how text reads", () => {
    const hidden = [
      "؜",
      "​",
      "‍",
      " ",
      "⁦",
      "﻿",
      String.fromCodePoint(0xe0041),
    ].join("");
    expect(safeText(`Git${hidden}Hub`, 80)).toBe("GitHub");
  });

  it("cuts on characters, never inside a surrogate pair", () => {
    const cut = safeText("😀".repeat(10), 5);
    expect([...cut]).toHaveLength(5);
    expect(cut.endsWith("…")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
  });
});

describe("a note is counted the way the Host counts it", () => {
  it("allows 280 characters, emoji included", async () => {
    expect(noteLength("😀".repeat(280))).toBe(280);
    joinSeams.eligible = () => true;
    joinSeams.pairedFetch = async () =>
      Response.json({ id: "r1", decision: "pending" }, { status: 202 });
    await expect(
      askToJoin(HOST, SESSION, "😀".repeat(280)),
    ).resolves.toMatchObject({ decision: "pending" });
    await expect(askToJoin(HOST, SESSION, "😀".repeat(281))).rejects.toThrow(
      JoinError,
    );
  });
});

describe("the address bar loses the invite and nothing else", () => {
  beforeEach(() => resetCapturedInviteForTests());
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("keeps the fragment's other parameters", () => {
    window.history.replaceState(
      null,
      "",
      `/join?x=1#token=${TOKEN}&endpoint=https%3A%2F%2Fa.example&view=list`,
    );
    captureInviteFromPage();
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#view=list");
  });

  it("keeps the fragment when a leaked query is scrubbed", () => {
    window.history.replaceState(null, "", `/join?token=${TOKEN}#view=list`);
    expect(captureInviteFromPage()).toEqual({ kind: "leaked" });
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#view=list");
  });

  it("says an invite is waiting when nobody on screen can open it", () => {
    watchInviteArrivals();
    window.history.replaceState(null, "", `/vault#token=${TOKEN}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(
      listNotices().some((notice) => notice.title === "An invite is waiting"),
    ).toBe(true);
    const stop = onInviteArrival(() => {});
    expect(takeCapturedInvite()?.kind).toBe("invite");
    expect(
      listNotices().some((notice) => notice.title === "An invite is waiting"),
    ).toBe(false);
    stop();
  });
});
