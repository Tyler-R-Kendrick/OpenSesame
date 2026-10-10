import { describe, expect, it } from "vitest";
import { canonicalize as browser } from "./digest-browser.js";
import { canonicalize as node } from "./digest.js";

describe("the browser canonicalizer", () => {
  it("keeps an own __proto__ member, as the node one does", () => {
    // JSON.parse makes `__proto__` an ordinary own key; assigning it would call
    // the prototype setter and silently drop it from the text, so a field a
    // person is shown could be a field nothing hashes.
    const value = JSON.parse('{"b":1,"__proto__":{"x":1},"a":2}');
    expect(browser(value)).toBe('{"__proto__":{"x":1},"a":2,"b":1}');
    expect(browser(value)).toBe(node(value));
  });

  it("agrees with the node one on ordinary input", () => {
    const value = { z: [3, { y: 1, x: 2 }], a: "text", m: null };
    expect(browser(value)).toBe(node(value));
  });
});
