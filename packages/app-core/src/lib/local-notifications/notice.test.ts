import { describe, expect, it } from "vitest";
import type { InboxRow } from "../device-inbox.js";
import { NOTICE_ROUTE, noticeOf, noticeWords, parseNotice } from "./notice.js";

const REF = "9f1c1a3e-7d1d-4f56-9f6f-2f9e0a0d4c11";

describe("what a notice carries", () => {
  it("is the closed contract and nothing the row said besides", () => {
    const row: InboxRow = {
      kind: "local-access",
      action: "review",
      ref: REF,
      expiresAt: "2026-10-04T10:05:00.000Z",
    };
    expect(noticeOf(row)).toEqual({
      kind: "local-access",
      action: "review",
      ref: REF,
    });
  });

  it("reads back exactly that and refuses anything else", () => {
    const notice = { kind: "local-access", action: "review", ref: REF };
    expect(parseNotice(notice)).toEqual(notice);
    expect(parseNotice({ ...notice, extra: "x" })).toEqual(notice);
    for (const bad of [
      null,
      "text",
      [],
      { ...notice, kind: "other" },
      { ...notice, action: "approve" },
      { ...notice, ref: "short" },
      { ...notice, ref: `${REF}/../x` },
      { kind: "local-access", action: "review" },
    ])
      expect(parseNotice(bad), JSON.stringify(bad)).toBeNull();
  });

  it("drops a field a click was not meant to honor", () => {
    expect(
      Object.keys(
        parseNotice({
          kind: "local-access",
          action: "review",
          ref: REF,
          decision: "approve",
          to: "https://elsewhere.example.test",
        }) ?? {},
      ).sort(),
    ).toEqual(["action", "kind", "ref"]);
  });
});

describe("the words", () => {
  it("say how many wait, and the same thing for every request", () => {
    expect(noticeWords(1)).toEqual({
      title: "Request waiting",
      body: "A request is waiting for you.",
    });
    expect(noticeWords(3)).toEqual({
      title: "Requests waiting",
      body: "3 requests are waiting for you.",
    });
  });

  it("lead to the list a request is decided from, not to a decision", () => {
    expect(NOTICE_ROUTE).toBe("/access?view=requests#local-requests");
  });
});
