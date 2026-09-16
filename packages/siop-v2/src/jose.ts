/**
 * The JOSE fence for Self-Issued ID Tokens.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { decodeBase64url, decodeUtf8 } from "./encoding.js";
import { type SiopV2Checkpoint, guarded, refuse } from "./errors.js";

export const SUPPORTED_SIGNATURE_ALGORITHMS = ["ES256"] as const;

export type SupportedSignatureAlgorithm =
  (typeof SUPPORTED_SIGNATURE_ALGORITHMS)[number];

export function isSupportedSignatureAlgorithm(
  value: string,
): value is SupportedSignatureAlgorithm {
  return SUPPORTED_SIGNATURE_ALGORITHMS.some(
    (candidate) => candidate === value,
  );
}

export interface CheckedCompactJws {
  readonly alg: SupportedSignatureAlgorithm;
  readonly typ: string | null;
  readonly kid: string | null;
  readonly header: JsonObject;
  readonly payload: JsonObject;
  readonly compact: string;
}

function parseJsonObject(text: string): JsonObject {
  const parsed: JsonValue = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new SyntaxError("not a JSON object");
  return parsed;
}

export function readSignedCompactJws(
  compact: string,
  checkpoint: SiopV2Checkpoint = "jose_header",
): CheckedCompactJws {
  const segments = compact.split(".");
  if (segments.length !== 3) {
    refuse("malformed_id_token", checkpoint);
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    refuse("malformed_id_token", checkpoint);
  }
  if (signatureSegment.length === 0) {
    refuse("algorithm_not_allowed", "jose_header");
  }

  const header = guarded(checkpoint, "malformed_id_token", () =>
    parseJsonObject(decodeUtf8(decodeBase64url(headerSegment))),
  );
  const payload = guarded(checkpoint, "malformed_id_token", () =>
    parseJsonObject(decodeUtf8(decodeBase64url(payloadSegment))),
  );

  const alg = header.alg;
  if (!isString(alg) || !isSupportedSignatureAlgorithm(alg)) {
    refuse("algorithm_not_allowed", "jose_header");
  }

  if (header.crit !== undefined) {
    refuse("algorithm_not_allowed", "jose_header");
  }

  return {
    alg,
    typ: isString(header.typ) ? header.typ : null,
    kid: isString(header.kid) ? header.kid : null,
    header,
    payload,
    compact,
  };
}
