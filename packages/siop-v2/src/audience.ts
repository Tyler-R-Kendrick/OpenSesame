/**
 * ID Token `aud` claim binding (string or single-element string array only).
 */

import type { JsonObject } from "@opensesame/os-domain";
import { isString } from "@opensesame/os-domain";
import { constantTimeEquals } from "./encoding.js";
import { refuse } from "./errors.js";

export function readAudience(payload: JsonObject, expected: string): string {
  const aud = payload.aud;
  if (isString(aud)) {
    if (!constantTimeEquals(aud, expected)) {
      refuse("audience_mismatch", "audience_binding");
    }
    return aud;
  }
  if (Array.isArray(aud)) {
    if (aud.length !== 1) {
      refuse("audience_mismatch", "audience_binding");
    }
    const entry = aud[0];
    if (!isString(entry) || !constantTimeEquals(entry, expected)) {
      refuse("audience_mismatch", "audience_binding");
    }
    return entry;
  }
  refuse("audience_mismatch", "audience_binding");
}
