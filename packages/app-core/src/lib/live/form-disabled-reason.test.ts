import { describe, expect, it } from "vitest";
import {
  liveHostStartDisabledReason,
  liveJoinAskDisabledReason,
} from "./form-disabled-reason.js";

describe("liveJoinAskDisabledReason", () => {
  it("names the first missing field", () => {
    expect(
      liveJoinAskDisabledReason({
        link: null,
        pasted: "",
        needsCode: false,
        code: "",
        name: "",
        busy: false,
      }),
    ).toBe("Paste a live-session link");
    expect(
      liveJoinAskDisabledReason({
        link: null,
        pasted: "not-a-link",
        needsCode: false,
        code: "",
        name: "",
        busy: false,
      }),
    ).toBe("Paste a live-session link that parses");
  });
});

describe("liveHostStartDisabledReason", () => {
  it("prefers transport refusal over empty title", () => {
    expect(
      liveHostStartDisabledReason({
        loaded: true,
        refused: "Routes file is invalid",
        starting: false,
        title: "",
        scope: "vault",
        chosenCount: 0,
      }),
    ).toBe("Routes file is invalid");
  });

  it("asks for items when scope is items", () => {
    expect(
      liveHostStartDisabledReason({
        loaded: true,
        refused: null,
        starting: false,
        title: "Team",
        scope: "items",
        chosenCount: 0,
      }),
    ).toBe("Choose at least one item");
  });
});
