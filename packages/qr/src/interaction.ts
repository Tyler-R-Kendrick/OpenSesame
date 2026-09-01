import {
  assertNoForbiddenParams,
  parseInteractionUrl,
} from "@opensesame/ceremony-kit";
import {
  QrEncodeError,
  type QrSvgOptions,
  type QrTerminalOptions,
  encodeQrSvg,
  encodeQrTerminal,
} from "./index.js";

/**
 * QR codes for cross-device interaction links (ADR 0086).
 *
 * A QR is the least revocable way to publish a URL. It is photographed off a
 * laptop screen by the person behind you, printed on a card that outlives the
 * ceremony, decoded by whatever camera app happens to be installed, and
 * scanned by services that fetch what they find. So the encoder refuses
 * material it must not immortalise, and it refuses it *before* reaching `uqr`:
 * once modules exist, the damage is a rendered image somebody may already have
 * screenshotted.
 *
 * This is why the check lives in `@opensesame/ceremony-kit` and is merely
 * called from here. There is one definition of "a link that must not exist",
 * shared by the builder and by every encoder of what the builder produced; a
 * second copy in this package would be a second copy to forget to update.
 *
 * Dependency direction: `@opensesame/qr` depends on `@opensesame/ceremony-kit`,
 * never the reverse. The kit is framework-, storage- and rendering-free, and
 * making it reach for an encoder would drag `uqr` into every surface that only
 * wanted to parse a link.
 */

/**
 * Encode an interaction link as an SVG QR.
 *
 * Two refusals, in this order. First `assertNoForbiddenParams` — a URL naming
 * credential material throws `InteractionLinkError` and `uqr` is never called.
 * Then the canonical-shape check: this function encodes *interaction* links,
 * and a payload that `parseInteractionUrl` does not recognise is either not one
 * or has been tampered with. Encoding an unrecognised URL under this name would
 * turn the function into a general encoder that merely sounds safe; callers
 * with something else to encode use `encodeQrSvg`.
 */
export function encodeInteractionQr(
  url: string,
  options: QrSvgOptions = {},
): string {
  assertInteractionPayload(url);
  return encodeQrSvg(url, options);
}

/**
 * The same link as a Unicode block QR, for a terminal handoff.
 *
 * Identical refusals: a terminal QR is scanned by the same cameras, and a
 * scrollback buffer is as durable as a screenshot.
 */
export function encodeInteractionQrTerminal(
  url: string,
  options: QrTerminalOptions = {},
): string {
  assertInteractionPayload(url);
  return encodeQrTerminal(url, options);
}

function assertInteractionPayload(url: string): void {
  assertNoForbiddenParams(url);
  if (parseInteractionUrl(url) === null) {
    throw new QrEncodeError("QR payload is not a canonical interaction link");
  }
}
