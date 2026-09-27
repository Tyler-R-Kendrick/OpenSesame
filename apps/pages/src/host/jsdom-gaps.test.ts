/** @vitest-environment jsdom */
/**
 * The test setup closes two jsdom gaps: `<search>` is the HTML element the
 * spec says it is, and `scrollBy` is quiet. Neither hides a real mistake.
 */
import { describe, expect, it } from "vitest";

const tagOf = (element: Element) => Object.prototype.toString.call(element);

describe("the jsdom gaps the test setup closes", () => {
  it("builds <search> as an HTMLElement, as a browser does", () => {
    const search = document.createElement("search");
    expect(tagOf(search)).toBe("[object HTMLElement]");
    expect(search).toBeInstanceOf(HTMLElement);
  });

  it("still builds a tag that is really unknown as unknown", () => {
    expect(tagOf(document.createElement("serch"))).toBe(
      "[object HTMLUnknownElement]",
    );
  });

  it("scrolls by nothing instead of reporting it is not implemented", () => {
    expect(window.scrollBy(0, 10)).toBeUndefined();
  });
});
