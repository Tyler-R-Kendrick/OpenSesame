import { describe, expect, it } from "vitest";
import {
  liveHostStartDisabledReason,
  liveJoinAskDisabledReason,
} from "./form-disabled-reason.js";
import type { LiveLink } from "./link.js";

const inviteLink: LiveLink = {
  admission: "invite",
  owner: "owner",
  secret: "secret",
  routes: null,
};

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
    expect(
      liveJoinAskDisabledReason({
        link: inviteLink,
        pasted: "",
        needsCode: true,
        code: "abcd",
        name: "Ada",
        busy: false,
      }),
    ).toBe("Enter the invite code, eight letters");
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
