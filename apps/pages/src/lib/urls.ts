/**
 * Where this page is allowed to send things.
 *
 * Both API base URLs are settings a person types and the app then persists, so
 * they are attacker-influenced the moment anything can write our storage. One of
 * them receives the operator token — a secret shared between processes on one
 * machine — so the destination has to be checked, not assumed.
 *
 * The checks themselves live in `@opensesame/api-client` alongside the fence the
 * extension already uses; there is one definition of "loopback" in this repo, not
 * one per surface.
 */
import {
  normalizeHttpBaseUrl,
  normalizeLoopbackBaseUrl,
} from "@opensesame/api-client";

export function isLoopbackUrl(raw: string): boolean {
  return normalizeLoopbackBaseUrl(raw) !== null;
}

/**
 * Normalize an API base, or return null when it is not one this page may use:
 * http is confined to loopback, and embedded credentials, queries and fragments
 * are refused outright.
 */
export function normalizeApiBase(raw: string): string | null {
  return normalizeHttpBaseUrl(raw);
}

/**
 * The operator token is only ever offered to this machine. A remote Host API is
 * somebody else's listener as far as that secret is concerned.
 */
export function operatorHeadersFor(
  base: string,
  operatorToken: string,
): Record<string, string> {
  if (!operatorToken || !isLoopbackUrl(base)) return {};
  return { authorization: `Bearer operator:${operatorToken}` };
}
