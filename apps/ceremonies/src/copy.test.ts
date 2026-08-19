import { describe, expect, it } from "vitest";
import { parseUserCode, readFragmentToken } from "./lib/deep-link.js";

describe("ceremonies deep-link helpers", () => {
  it("reads a claim bearer from the fragment only", () => {
    expect(readFragmentToken("#token=osc_clm_abc.def")).toBe("osc_clm_abc.def");
    expect(readFragmentToken("token=osc_clm_abc.def")).toBe("osc_clm_abc.def");
    expect(readFragmentToken("#other=x")).toBeNull();
    expect(readFragmentToken("")).toBeNull();
    expect(readFragmentToken("#token=")).toBeNull();
  });

  it("normalizes a user code from the query string", () => {
    expect(parseUserCode("?user_code=abcd-efgh")).toBe("ABCD-EFGH");
    expect(parseUserCode("user_code=%20wxyz-1234%20")).toBe("WXYZ-1234");
    expect(parseUserCode("?other=x")).toBeNull();
    expect(parseUserCode("")).toBeNull();
    expect(parseUserCode("?user_code=%20%20")).toBeNull();
  });
});
