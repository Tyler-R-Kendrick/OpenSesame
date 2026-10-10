/**
 * Two things a real browser has and jsdom does not, closed once so that a
 * test's stderr carries only what the test is about. Nothing here runs
 * outside a jsdom test.
 *
 * - `<search>` is an HTML element whose interface is plain `HTMLElement`
 *   (HTML § 4.4.15). jsdom 26 builds it as `HTMLUnknownElement`, so React's
 *   development build warns that the tag is unrecognized on every render of
 *   the command bar. `HTMLUnknownElement` adds no members to `HTMLElement`,
 *   so giving the element the prototype the spec names changes only what it
 *   says it is. A tag that really is unknown still warns.
 * - `window.scrollBy` exists but only reports "not implemented". jsdom does
 *   no layout, so there is nothing to scroll; doing nothing is what a page
 *   with no overflow does. A test that cares still replaces it with a spy.
 */

const HTML_NS = "http://www.w3.org/1999/xhtml";

function knowTheSearchElement(): void {
  const create = Document.prototype.createElement;
  function createElement(
    this: Document,
    tagName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    const element = create.call(this, tagName, options);
    if (
      element.localName === "search" &&
      element.namespaceURI === HTML_NS &&
      element instanceof HTMLUnknownElement
    ) {
      Object.setPrototypeOf(element, HTMLElement.prototype);
    }
    return element;
  }
  Object.defineProperty(Document.prototype, "createElement", {
    value: createElement,
    configurable: true,
    writable: true,
  });
}

export function closeJsdomGaps(): void {
  if (globalThis.document === undefined) return;
  knowTheSearchElement();
  window.scrollBy = () => undefined;
}
