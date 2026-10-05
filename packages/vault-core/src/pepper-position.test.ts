import { describe, expect, it } from "vitest";
import {
  isPepperPosition,
  parsePepperPosition,
  splitAtPepper,
} from "./pepper-position.js";

const PASSWORD = "abcdefghij";

/** What the person's whole password is: their pepper put where the expression says. */
function whole(expression: string | undefined, pepper = "<P>"): string {
  const { head, tail } = splitAtPepper(PASSWORD, expression);
  return `${head}${pepper}${tail}`;
}

describe("where a pepper goes, written like a Python index", () => {
  it("goes last when nothing is said, or `end`", () => {
    expect(whole(undefined)).toBe("abcdefghij<P>");
    expect(whole("")).toBe("abcdefghij<P>");
    expect(whole("end")).toBe("abcdefghij<P>");
    expect(whole("  END ")).toBe("abcdefghij<P>");
  });

  it("goes before the character at a positive index", () => {
    expect(whole("0")).toBe("<P>abcdefghij");
    expect(whole("3")).toBe("abc<P>defghij");
    expect(whole("10")).toBe("abcdefghij<P>");
    expect(whole("99")).toBe("abcdefghij<P>");
  });

  it("counts from the end for a negative index, as Python does", () => {
    expect(whole("-1")).toBe("abcdefghi<P>j");
    expect(whole("-3")).toBe("abcdefg<P>hij");
    expect(whole("-10")).toBe("<P>abcdefghij");
    expect(whole("-99")).toBe("<P>abcdefghij");
  });

  it("stands in for a slice, either bound optional, brackets allowed", () => {
    expect(whole("2:5")).toBe("ab<P>fghij");
    expect(whole(":4")).toBe("<P>efghij");
    expect(whole("-3:")).toBe("abcdefg<P>");
    expect(whole("[2:5]")).toBe("ab<P>fghij");
    expect(whole(" 2 : 5 ")).toBe("ab<P>fghij");
    expect(whole(":")).toBe("<P>");
    expect(whole("-4:-1")).toBe("abcdef<P>j");
  });

  it("clamps a slice and treats an empty or backwards one as an insertion", () => {
    expect(whole("5:2")).toBe("abcde<P>fghij");
    expect(whole("3:3")).toBe("abc<P>defghij");
    expect(whole("8:99")).toBe("abcdefgh<P>");
    expect(whole("-99:2")).toBe("<P>cdefghij");
  });

  it("cuts an empty password without raising", () => {
    expect(splitAtPepper("", "3")).toEqual({ head: "", tail: "" });
    expect(splitAtPepper("", "-2:")).toEqual({ head: "", tail: "" });
  });

  it("falls back to the end for text that is not a position", () => {
    expect(whole("middle")).toBe("abcdefghij<P>");
    expect(whole("1:2:3")).toBe("abcdefghij<P>");
    expect(whole("1.5")).toBe("abcdefghij<P>");
  });

  it("says which text is a position a person can save", () => {
    for (const ok of ["", "end", "0", "-1", "3", "2:5", ":4", "-3:", "[1:2]"]) {
      expect(isPepperPosition(ok), ok).toBe(true);
    }
    for (const bad of ["mid", "1:2:3", "1.5", "a:b", "[1", "::"]) {
      expect(isPepperPosition(bad), bad).toBe(false);
    }
    expect(parsePepperPosition("3")).toEqual({ kind: "insert", index: 3 });
    expect(parsePepperPosition("2:")).toEqual({
      kind: "replace",
      start: 2,
      stop: null,
    });
  });
});
