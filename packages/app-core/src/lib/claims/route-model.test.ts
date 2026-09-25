// @vitest-environment jsdom
/**
 * The `/claim` route's view-model: where an arrival starts, what a pasted
 * entry is, and the one tray notice a claim reports through.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearNotices, listNotices } from "../notices.js";
import { CLAIM_WORDS, type ClaimCeremony } from "./ceremony.js";
import {
  CLAIM_NOTICE,
  claimEntry,
  claimStartFor,
  clearClaimNotice,
  reportClaim,
} from "./route-model.js";
import { claimStash } from "./stash.js";

const TOKEN = "osc_clm_pub.secret"; // gitleaks:allow -- synthetic claim-shaped test vector

const ceremony: Pick<ClaimCeremony, "start"> = {
  start: (arrival) =>
    arrival.kind === "leaked"
      ? { kind: "refused", message: CLAIM_WORDS.leaked }
      : { kind: "idle" },
};

afterEach(() => {
  sessionStorage.clear();
  clearNotices();
});

describe("claimStartFor", () => {
  it("presents a fresh bearer", () => {
    expect(claimStartFor(ceremony, { kind: "claim", token: TOKEN })).toEqual({
      kind: "load",
      token: TOKEN,
      presented: false,
    });
  });

  it("reads back a bearer this tab already presented, never presents it twice", () => {
    claimStash.write({
      token: TOKEN,
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
    expect(claimStartFor(ceremony, { kind: "claim", token: TOKEN })).toEqual({
      kind: "load",
      token: TOKEN,
      presented: true,
    });
  });

  it("hands anything else to the ceremony", () => {
    expect(claimStartFor(ceremony, { kind: "leaked" })).toEqual({
      kind: "refused",
      message: CLAIM_WORDS.leaked,
    });
    expect(claimStartFor(ceremony, { kind: "none" })).toEqual({
      kind: "idle",
    });
  });
});

describe("claimEntry", () => {
  it("reads a bare token, a claim link and a drop link", () => {
    expect(claimEntry("")).toBeNull();
    expect(claimEntry(`  ${TOKEN}  `)).toEqual({ kind: "claim", token: TOKEN });
    expect(
      claimEntry(`https://pages.example/OpenSesame/claim#token=${TOKEN}`),
    ).toEqual({ kind: "claim", token: TOKEN });
    expect(
      claimEntry(`https://pages.example/claim#token=${TOKEN}&key=a2V5`),
    ).toEqual({ kind: "drop", token: TOKEN, key: "a2V5" });
  });

  it("refuses a query-string bearer and anything that is not a claim", () => {
    expect(claimEntry(`https://pages.example/claim?token=${TOKEN}`)).toEqual({
      kind: "leaked",
    });
    expect(claimEntry("osc_dlg_abc.def")).toEqual({ kind: "none" });
    expect(claimEntry("https://pages.example/claim#other=1")).toEqual({
      kind: "none",
    });
  });
});

describe("the claim notice", () => {
  it("is one notice: a failure, then a drop refusal, then nothing", () => {
    reportClaim("That code did not match.");
    reportClaim("This drop was already opened.", "Drop");
    const notices = listNotices().filter((n) => n.id === CLAIM_NOTICE);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      tone: "err",
      title: "Drop",
      body: "This drop was already opened.",
    });
    clearClaimNotice();
    expect(listNotices().some((n) => n.id === CLAIM_NOTICE)).toBe(false);
  });
});
