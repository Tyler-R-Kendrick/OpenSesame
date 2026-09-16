/**
 * Reading a wallet's response off a courier — or refusing it, honestly.
 *
 * A "courier" is any transport that carries the wallet's Authorization Response
 * back to the verifier without being the verifier's own `direct_post` endpoint:
 * a relay, an inbox, a cross-device hop (ADR 0046/0086). The response arrives as
 * a body of parameters this function turns into the {@link PresentationResponse}
 * that `verifyPresentation` re-validates.
 *
 * The security-bearing job here is what it does with an **encrypted** response.
 * OpenID4VP §8.3 defines `direct_post.jwt` and `dc_api.jwt`, whose payload is a
 * JWE the wallet encrypted to a key the verifier published. This package does
 * not decrypt JWE (see `SUPPORT_MATRIX`), and the wrong thing to do with a
 * response it cannot read is to fall back to reading it as cleartext. So this
 * function fails closed two ways:
 *
 * - an encrypted **response mode** is refused by name, and
 * - a body carrying a compact JWE under a cleartext mode is refused too, so a
 *   courier cannot smuggle "here is the encrypted response, just take the
 *   `state` off the outside" past a verifier that would then never check the
 *   sealed part.
 *
 * The refusal is a typed `response_encryption_unsupported`, not a silent
 * degrade: a deployment that needs confidential responses learns it must add a
 * JWE-capable verifier rather than discovering, later, that its "encrypted"
 * channel was read in the clear.
 */

import { type JsonObject, isJsonObject, isString } from "@opensesame/os-domain";
import { isBase64url } from "./encoding.js";
import { refuse } from "./errors.js";
import type { PresentationResponse } from "./verify.js";

/**
 * The §8.3 response modes whose payload is a JWE.
 *
 * Recognized so they are refused by name rather than through a default branch —
 * the same discipline `mso_mdoc` gets in the DCQL profile.
 */
export const ENCRYPTED_RESPONSE_MODES = [
  "direct_post.jwt",
  "dc_api.jwt",
] as const;

export type EncryptedResponseMode = (typeof ENCRYPTED_RESPONSE_MODES)[number];

export function isEncryptedResponseMode(
  value: string,
): value is EncryptedResponseMode {
  return ENCRYPTED_RESPONSE_MODES.some((candidate) => candidate === value);
}

/**
 * What a courier hands over: the transport-observed mode and the body.
 *
 * `responseMode` is what the *transport* saw, exactly as `verifyPresentation`
 * requires — a form POST is `direct_post`, a resolved DC API promise is
 * `dc_api`, and a JWE-bearing channel is one of {@link ENCRYPTED_RESPONSE_MODES}.
 * `state` is separate because over the DC API there is no `state` in the body
 * (§A.2) and the courier supplies it from the session it has held all along.
 */
export interface CourierDelivery {
  readonly responseMode: string;
  readonly body: JsonObject;
  /** Overrides `body.state`; required for `dc_api`, where the body has none. */
  readonly state?: string | undefined;
}

/**
 * A compact JWE has exactly five base64url segments (RFC 7516 §3.1).
 *
 * Distinguishing it from a compact JWS (three segments) is enough to catch an
 * encrypted payload arriving under a cleartext mode; this is a fail-closed
 * shape check, not a parser, and it never decodes the segments.
 */
export function isCompactJwe(value: string): boolean {
  const segments = value.split(".");
  if (segments.length !== 5) return false;
  return segments.every(
    (segment) => segment.length === 0 || isBase64url(segment),
  );
}

/**
 * Turn a courier delivery into a {@link PresentationResponse}, or refuse.
 *
 * Refuses an encrypted mode and a smuggled JWE before it reads anything else,
 * then reads `vp_token` and `state` through the same boundary guards
 * `verifyPresentation` uses, so a malformed body becomes a typed refusal here
 * rather than a `TypeError` a frame deeper.
 */
export function readCourierResponse(
  delivery: CourierDelivery,
): PresentationResponse {
  if (isEncryptedResponseMode(delivery.responseMode)) {
    refuse("response_encryption_unsupported", "response_decryption");
  }
  if (!isJsonObject(delivery.body)) {
    refuse("malformed_presentation", "response_envelope");
  }
  const sealed = delivery.body.response;
  if (isString(sealed) && isCompactJwe(sealed)) {
    // A cleartext mode carrying a JWE: refuse rather than read the envelope's
    // outside and ignore the sealed part.
    refuse("response_encryption_unsupported", "response_decryption");
  }
  const state = delivery.state ?? delivery.body.state;
  if (!isString(state) || state.length === 0) {
    refuse("state_unknown", "session_lookup");
  }
  const vpToken = delivery.body.vp_token;
  if (!isJsonObject(vpToken)) {
    refuse("malformed_presentation", "vp_token_shape");
  }
  return { state, responseMode: delivery.responseMode, vpToken };
}
