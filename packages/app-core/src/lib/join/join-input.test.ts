// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptedItemIds,
  initialSelection,
  lockedItems,
  toggleItem,
} from "./consent.js";
import {
  captureInviteFromPage,
  normalizeInviteCode,
  normalizeSessionId,
  onInviteArrival,
  parseInvite,
  resetCapturedInviteForTests,
  takeCapturedInvite,
  watchInviteArrivals,
} from "./invite.js";
import {
  clearPendingJoin,
  readPendingJoin,
  writePendingJoin,
} from "./stash.js";
import {
  JoinWireError,
  readOffer,
  readOpenSessions,
  readReceipt,
} from "./wire.js";

const TOKEN = `osc_dlg_dlgo_${"a".repeat(32)}.${"B".repeat(43)}`;

/** An offer item as the endpoint spells it. */
type WireItem = {
  id: string;
  connection_id: string;
  provider_id: string;
  display_name: string;
  actions: string[];
  resources: string[];
  required: boolean;
  dependencies: string[];
};

function offerBody(items: WireItem[]) {
  return {
    offer: {
      id: "dlgo_1",
      state: "presented",
      manifest_digest: "sha256:ab",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      items,
    },
  };
}

function item(id: string, over?: Partial<WireItem>): WireItem {
  return {
    id,
    connection_id: `c_${id}`,
    provider_id: "github",
    display_name: `Item ${id}`,
    actions: ["read"],
    resources: ["repo:x"],
    required: false,
    dependencies: [],
    ...over,
  };
}

describe("invites", () => {
  it("reads a bare token and a fragment link, and nothing else", () => {
    expect(parseInvite(TOKEN)).toEqual({ token: TOKEN, endpoint: null });
    expect(
      parseInvite(
        `https://pages.example/join#token=${TOKEN}&endpoint=${encodeURIComponent("https://vault.example.org/")}`,
      ),
    ).toEqual({ token: TOKEN, endpoint: "https://vault.example.org" });
    // A query-borne bearer, arbitrary text, a claim-drop token: refused.
    expect(parseInvite(`https://pages.example/join?token=${TOKEN}`)).toBeNull();
    expect(parseInvite("hello there")).toBeNull();
    expect(parseInvite("osc_clm_abc.def")).toBeNull();
    expect(parseInvite(`javascript:alert(1)#token=${TOKEN}`)).toBeNull();
  });

  it("drops an endpoint a page may not call, keeping the invite", () => {
    const parsed = parseInvite(
      `https://pages.example/#token=${TOKEN}&endpoint=http://evil.example`,
    );
    expect(parsed).toEqual({ token: TOKEN, endpoint: null });
  });

  it("normalizes the code to the endpoint's spelling, or refuses it", () => {
    expect(normalizeInviteCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
    expect(normalizeInviteCode("BCDF-GHJK")).toBe("BCDF-GHJK");
    // Vowels and digits are outside the alphabet: never sent, never counted.
    expect(normalizeInviteCode("ABCD-1234")).toBeNull();
    expect(normalizeInviteCode("BCDFGHJ")).toBeNull();
  });

  it("normalizes a session id", () => {
    const uuid = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(normalizeSessionId(uuid.toUpperCase())).toBe(`session:${uuid}`);
    expect(normalizeSessionId(`session:${uuid}`)).toBe(`session:${uuid}`);
    expect(normalizeSessionId("../admin")).toBeNull();
  });
});

describe("capturing an invite from the address bar", () => {
  beforeEach(() => resetCapturedInviteForTests());
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("takes the bearer out of history before anything renders", () => {
    window.history.replaceState(null, "", `/join?x=1#token=${TOKEN}`);
    expect(captureInviteFromPage()).toEqual({
      kind: "invite",
      invite: { token: TOKEN, endpoint: null },
    });
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?x=1");
    expect(takeCapturedInvite()?.kind).toBe("invite");
    expect(takeCapturedInvite()).toBeNull();
  });

  it("scrubs a query-borne bearer and marks it leaked", () => {
    window.history.replaceState(null, "", `/join?token=${TOKEN}&x=1`);
    expect(captureInviteFromPage()).toEqual({ kind: "leaked" });
    expect(window.location.search).toBe("?x=1");
  });

  it("takes an invite pasted into an already-open tab, and says so", () => {
    const heard = vi.fn();
    const stop = onInviteArrival(heard);
    watchInviteArrivals();
    window.history.replaceState(null, "", `/vault#token=${TOKEN}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
    expect(takeCapturedInvite()?.kind).toBe("invite");
    stop();
  });

  it("leaves a drop link's fragment exactly as it arrived", () => {
    window.history.replaceState(null, "", "/claim#token=osc_clm_a.b&key=k");
    expect(captureInviteFromPage()).toBeNull();
    expect(window.location.hash).toBe("#token=osc_clm_a.b&key=k");
  });
});

describe("reading an offer", () => {
  it("keeps what a person needs, bounded and cleaned", () => {
    const offer = readOffer(
      offerBody([
        item("a", { display_name: "Repo‮ evil\u0007", required: true }),
        item("b", { dependencies: ["a"] }),
      ]),
    );
    expect(offer.items.map((entry) => entry.displayName)).toEqual([
      "Repo evil",
      "Item b",
    ]);
    expect(offer.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses an offer that names something it does not carry", () => {
    expect(() =>
      readOffer(offerBody([item("a", { dependencies: ["ghost"] })])),
    ).toThrow(JoinWireError);
    expect(() => readOffer(offerBody([item("a"), item("a")]))).toThrow();
    expect(() => readOffer(offerBody([item("../x")]))).toThrow();
    expect(() => readOffer(offerBody([]))).toThrow();
    expect(() =>
      readOffer(
        offerBody(Array.from({ length: 33 }, (_, at) => item(`i${at}`))),
      ),
    ).toThrow();
  });

  it("reads receipts and session lists strictly", () => {
    expect(readReceipt({ id: "r1", decision: "pending" }).decision).toBe(
      "pending",
    );
    expect(() => readReceipt({ id: "r1", decision: "maybe" })).toThrow();
    expect(
      readOpenSessions({
        sessions: [
          { id: "session:x", display_name: "Team" },
          { id: "bad id", display_name: "x" },
          {
            id: "session:y",
            display_name: "Lobby",
            admission: "observer_on_ask",
          },
          // Only the exact spelling promises an admission.
          { id: "session:z", display_name: "Desk", admission: "on_ask" },
        ],
      }),
    ).toEqual([
      { id: "session:x", displayName: "Team", admitsOnAsk: false },
      { id: "session:y", displayName: "Lobby", admitsOnAsk: true },
      { id: "session:z", displayName: "Desk", admitsOnAsk: false },
    ]);
    expect(
      readReceipt({ id: "r1", decision: "admitted", mode: "observer" }).mode,
    ).toBe("observer");
    // A mode beside anything but an admission is not a seat.
    expect(
      readReceipt({ id: "r1", decision: "pending", mode: "observer" }).mode,
    ).toBeNull();
  });
});

describe("choosing what to accept", () => {
  const offer = readOffer(
    offerBody([
      item("base", { required: true }),
      item("need", {}),
      item("uses-need", { dependencies: ["need"] }),
      item("pinned-by-required", {}),
      item("req2", { required: true, dependencies: ["pinned-by-required"] }),
    ]),
  );

  it("starts on the required items only — optional ones are off", () => {
    expect([...initialSelection(offer)].sort()).toEqual(
      ["base", "pinned-by-required", "req2"].sort(),
    );
    expect(lockedItems(offer).has("pinned-by-required")).toBe(true);
  });

  it("brings dependencies on, takes dependents off, never moves a lock", () => {
    let chosen = initialSelection(offer);
    chosen = toggleItem(offer, chosen, "uses-need");
    expect(chosen.has("need")).toBe(true);
    chosen = toggleItem(offer, chosen, "need");
    expect(chosen.has("uses-need")).toBe(false);
    expect(toggleItem(offer, chosen, "base")).toBe(chosen);
    expect(toggleItem(offer, chosen, "unknown")).toBe(chosen);
    expect(acceptedItemIds(offer, new Set())).toEqual([
      "base",
      "pinned-by-required",
      "req2",
    ]);
  });
});

describe("the pending join", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps the offer for this tab and never the code", () => {
    const offer = readOffer(offerBody([item("a")]));
    writePendingJoin({
      endpoint: "https://vault.example.org",
      token: TOKEN,
      offer,
    });
    const raw = sessionStorage.getItem("join.pending.v2") ?? "";
    expect(raw).not.toMatch(/code/i);
    expect(readPendingJoin()?.offer.items[0]?.id).toBe("a");
    clearPendingJoin();
    expect(readPendingJoin()).toBeNull();
  });

  it("forgets it when the offer ends, and erases the removed ceremony's entry", () => {
    const offer = readOffer(offerBody([item("a")]));
    writePendingJoin({
      endpoint: "https://vault.example.org",
      token: TOKEN,
      offer,
    });
    expect(readPendingJoin(Date.now() + 11 * 60_000)).toBeNull();
    expect(sessionStorage.getItem("join.pending.v2")).toBeNull();
    sessionStorage.setItem("join.invite.v1", '{"userCode":"BCDF-GHJK"}');
    readPendingJoin();
    expect(sessionStorage.getItem("join.invite.v1")).toBeNull();
  });

  it("refuses a tampered entry", () => {
    sessionStorage.setItem(
      "join.pending.v2",
      JSON.stringify({ v: 2, endpoint: "http://evil.example", token: TOKEN }),
    );
    expect(readPendingJoin()).toBeNull();
  });
});
