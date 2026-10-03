import { describe, expect, it } from "vitest";
import { isOwnPage } from "./sender";

const BASE = "chrome-extension://abc/";

describe("who may ask the runner", () => {
  it("an extension page of its own", () => {
    for (const url of [
      "chrome-extension://abc/options.html",
      "chrome-extension://abc/popup.html?x=1",
      "chrome-extension://abc/",
    ]) {
      expect(isOwnPage({ id: "abc", url }, "abc", BASE), url).toBe(true);
    }
  });

  it("not a content script, not another extension, not a lookalike", () => {
    for (const sender of [
      { id: "abc", url: "https://rp.example/page" },
      { id: "abc", url: "chrome-extension://abcd/options.html" },
      { id: "abc", url: "chrome-extension://abc.evil/options.html" },
      { id: "other", url: "chrome-extension://abc/options.html" },
      { id: "abc" },
      { url: "chrome-extension://abc/options.html" },
      {},
    ]) {
      expect(isOwnPage(sender, "abc", BASE), JSON.stringify(sender)).toBe(
        false,
      );
    }
  });

  it("refuses everything when the base is not a directory", () => {
    expect(
      isOwnPage(
        { id: "abc", url: "chrome-extension://abcd/x" },
        "abc",
        "chrome-extension://abc",
      ),
    ).toBe(false);
  });
});
