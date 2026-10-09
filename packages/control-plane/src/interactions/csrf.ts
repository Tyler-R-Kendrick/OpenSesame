import { randomBytes, timingSafeEqual } from "node:crypto";

interface CsrfEntry {
  token: string;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;

export interface InteractionCsrf {
  /** Issue a CSRF token bound to an interaction uid. */
  issue(uid: string, now?: number): string;
  /** Validate and consume a CSRF token for the interaction uid. */
  verify(uid: string, submitted: string | undefined, now?: number): boolean;
}

/**
 * Synchronizer-token CSRF for the interaction forms (ADR 0050 F6). The
 * interaction pages are same-origin form POSTs authenticated by ambient
 * cookies, so every POST must present the token the matching GET rendered.
 * Tokens are single-use and short-lived; one store per Hono app (not a
 * module global) so parallel test servers never share state.
 */
export function createInteractionCsrf(): InteractionCsrf {
  const tokens = new Map<string, CsrfEntry>();

  function purgeExpired(now: number): void {
    for (const [uid, entry] of tokens) {
      if (entry.expiresAt <= now) tokens.delete(uid);
    }
  }

  return {
    issue(uid, now = Date.now()) {
      purgeExpired(now);
      const token = randomBytes(24).toString("base64url");
      tokens.set(uid, { token, expiresAt: now + TTL_MS });
      return token;
    },

    verify(uid, submitted, now = Date.now()) {
      purgeExpired(now);
      if (!submitted) return false;
      const entry = tokens.get(uid);
      if (!entry || entry.expiresAt <= now) {
        tokens.delete(uid);
        return false;
      }
      const a = Buffer.from(entry.token);
      const b = Buffer.from(submitted);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      tokens.delete(uid);
      return true;
    },
  };
}
