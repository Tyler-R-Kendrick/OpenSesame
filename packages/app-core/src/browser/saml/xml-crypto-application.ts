/** Browser XMLDSIG engine; the closed build adapter retains the official XML verifier. */
import { XE, XmlError } from "xml-core";

type NamedCrypto = Crypto & { name: string };
let engine: NamedCrypto | null = null;

/** SDK-compatible engine ownership without installing a second certificate engine. */
export const Application = {
  setEngine(name: string, crypto: Crypto): void {
    engine = Object.assign(crypto, { name });
  },

  get crypto(): NamedCrypto {
    if (!engine) throw new XmlError(XE.CRYPTOGRAPHIC_NO_MODULE);
    return engine;
  },

  isNodePlugin(): boolean {
    return !("self" in globalThis) && !("window" in globalThis);
  },
};

if (!Application.isNodePlugin())
  Application.setEngine("W3 WebCrypto module", self.crypto);
