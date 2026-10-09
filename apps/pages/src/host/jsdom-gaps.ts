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

function makeStubCanvas2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const measureText = (text: string): TextMetrics => {
    const width = text.length * 6;
    const metrics = {
      width,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      fontBoundingBoxAscent: 8,
      fontBoundingBoxDescent: 2,
      emHeightAscent: 8,
      emHeightDescent: 2,
      hangingBaseline: 6,
      alphabeticBaseline: 0,
      ideographicBaseline: -2,
    };
    return metrics;
  };
  const stub = {
    canvas,
    font: "10px monospace",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    lineJoin: "round",
    globalCompositeOperation: "source-over",
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    strokeText: () => undefined,
    beginPath: () => undefined,
    fill: () => undefined,
    rect: () => undefined,
    moveTo: () => undefined,
    arc: () => undefined,
    measureText,
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
      colorSpace: "srgb",
    }),
  };
  // SAFETY: jsdom stub implements only the 2d methods CipherWordmark touches in tests.
  return stub as CanvasRenderingContext2D;
}

function stubCanvas2d(): void {
  const proto = HTMLCanvasElement.prototype;
  if (!proto.getContext) return;
  const original = proto.getContext;
  proto.getContext = function getContext(
    this: HTMLCanvasElement,
    type: string,
    options?: CanvasRenderingContext2DSettings,
  ): RenderingContext | null {
    if (type !== "2d") {
      return original.call(this, type, options);
    }
    // jsdom logs "Not implemented" even when the throw is caught — skip it.
    return makeStubCanvas2d(this);
  };
}

function stubResizeObserver(): void {
  if (typeof globalThis.ResizeObserver !== "undefined") return;
  class ResizeObserverStub {
    observe(): void {
      /* jsdom has no layout */
    }
    unobserve(): void {
      /* jsdom has no layout */
    }
    disconnect(): void {
      /* jsdom has no layout */
    }
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}

export function closeJsdomGaps(): void {
  if (globalThis.document === undefined) return;
  knowTheSearchElement();
  window.scrollBy = () => undefined;
  stubCanvas2d();
  stubResizeObserver();
}
