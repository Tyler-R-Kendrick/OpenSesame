/** The KDBX SDK prefers these same native APIs before its Node-only fallback. */
class MissingDOMParser {
  constructor() {
    throw new Error("KDBX requires a browser document with native DOMParser.");
  }
}

class MissingXMLSerializer {
  constructor() {
    throw new Error(
      "KDBX requires a browser document with native XMLSerializer.",
    );
  }
}

export const DOMParser = globalThis.DOMParser ?? MissingDOMParser;
export const XMLSerializer = globalThis.XMLSerializer ?? MissingXMLSerializer;
