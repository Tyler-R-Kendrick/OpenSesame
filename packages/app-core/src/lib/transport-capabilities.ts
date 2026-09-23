/**
 * `transport.capabilities.discover` on the PWA surface: what this runtime —
 * a static page — supports. Answered from the page itself, without probing
 * anything: a PWA cannot hand a vault key to the TLS handshake, pick a
 * certificate through `fetch`, or install OS trust; a browser-held
 * certificate is provisioned outside it (BROWSER-BOUNDARY).
 */
import {
  type TransportCapabilities,
  browserCapabilities,
} from "./transport-model.js";

export type { TransportCapabilities };

export function transportCapabilities(): TransportCapabilities {
  return browserCapabilities();
}
