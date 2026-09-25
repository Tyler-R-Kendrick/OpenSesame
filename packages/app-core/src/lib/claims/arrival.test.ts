// @vitest-environment jsdom
/**
 * What a `/claim` link leaves behind once boot has taken it out of the
 * address: a claim in memory and in the tab's stash, a drop in memory only,
 * a leaked bearer refused — and nothing read on any other path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import {
  captureClaimArrivalFromPage,
  claimPath,
  forgetClaim,
  forgetClaimOnLock,
  markClaimShown,
  peekClaimArrival,
  resetClaimArrivalForTests,
  takeClaimArrival,
} from "./arrival.js";
import { claimStash } from "./stash.js";

const TOKEN = "osc_clm_pub.secret"; // gitleaks:allow -- synthetic claim-shaped test vector
const KEY = "a2V5LW1hdGVyaWFs"; // gitleaks:allow -- synthetic drop key test vector

afterEach(() => {
  history.replaceState(null, "", "/");
  resetClaimArrivalForTests();
  sessionStorage.clear();
  configureHost(createTestHost());
});

describe("captureClaimArrivalFromPage", () => {
  it("takes a claim bearer out of the fragment, holds it, and stashes it", () => {
    history.replaceState(null, "", `/claim#token=${TOKEN}`);
    expect(captureClaimArrivalFromPage()).toEqual({
      kind: "claim",
      token: TOKEN,
    });
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      "/claim",
    );
    expect(peekClaimArrival()).toEqual({ kind: "claim", token: TOKEN });
    // It must survive a sign-in that leaves the page.
    expect(claimStash.read()).toMatchObject({
      token: TOKEN,
      presented: false,
    });
  });

  it("holds a drop in memory only: no stash, no key anywhere in storage", () => {
    history.replaceState(null, "", `/claim#token=${TOKEN}&key=${KEY}`);
    expect(captureClaimArrivalFromPage()).toEqual({
      kind: "drop",
      token: TOKEN,
      key: KEY,
    });
    expect(location.hash).toBe("");
    expect(claimStash.read()).toBeNull();
    const stored = JSON.stringify({ ...sessionStorage, ...localStorage });
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain(TOKEN);
  });

  it("refuses a bearer the query string carried, and scrubs it", () => {
    history.replaceState(null, "", `/claim?token=${TOKEN}&x=1`);
    expect(captureClaimArrivalFromPage()).toEqual({ kind: "leaked" });
    expect(location.search).toBe("?x=1");
    expect(claimStash.read()).toBeNull();
    expect(peekClaimArrival()).toEqual({ kind: "leaked" });
  });

  it("reads nothing on any other path", () => {
    for (const path of [
      `/#token=${TOKEN}`,
      `/join#token=${TOKEN}`,
      `/claims#token=${TOKEN}`,
      `/vault?token=${TOKEN}`,
    ]) {
      history.replaceState(null, "", path);
      expect(captureClaimArrivalFromPage()).toEqual({ kind: "none" });
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(
        path,
      );
    }
    expect(peekClaimArrival()).toEqual({ kind: "none" });
    expect(claimStash.read()).toBeNull();
  });

  it("reads the route under the deployment base", () => {
    configureHost(createTestHost({ env: { BASE_URL: "/OpenSesame/" } }));
    expect(claimPath("/OpenSesame/")).toBe("/OpenSesame/claim");
    history.replaceState(null, "", `/claim#token=${TOKEN}`);
    expect(captureClaimArrivalFromPage()).toEqual({ kind: "none" });
    history.replaceState(null, "", `/OpenSesame/claim/#token=${TOKEN}`);
    expect(captureClaimArrivalFromPage()).toEqual({
      kind: "claim",
      token: TOKEN,
    });
  });

  it("keeps what a presented bearer had done when the same link reopens", () => {
    claimStash.write({
      token: TOKEN,
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    history.replaceState(null, "", `/claim#token=${TOKEN}`);
    captureClaimArrivalFromPage();
    expect(claimStash.read()).toMatchObject({ presented: true });
  });

  it("keeps the waiting arrival when the clean address is read again", () => {
    history.replaceState(null, "", `/claim#token=${TOKEN}`);
    captureClaimArrivalFromPage();
    expect(captureClaimArrivalFromPage()).toEqual({ kind: "none" });
    expect(takeClaimArrival()).toEqual({ kind: "claim", token: TOKEN });
    expect(peekClaimArrival()).toEqual({ kind: "none" });
  });
});

describe("forgetting a claim", () => {
  it("sign-out forgets the arrival and the stashed bearer", () => {
    history.replaceState(null, "", `/claim#token=${TOKEN}`);
    captureClaimArrivalFromPage();
    forgetClaim();
    expect(peekClaimArrival()).toEqual({ kind: "none" });
    expect(claimStash.read()).toBeNull();
  });

  it("a lock forgets only a claim the locked session was shown", () => {
    history.replaceState(null, "", `/claim#token=${TOKEN}&key=${KEY}`);
    captureClaimArrivalFromPage();
    // Locked when the link opened: the guest road can still reach it.
    forgetClaimOnLock();
    expect(peekClaimArrival().kind).toBe("drop");
    markClaimShown();
    forgetClaimOnLock();
    expect(peekClaimArrival()).toEqual({ kind: "none" });
  });
});
