/**
 * The console's operator bearer comes from a build-time variable, which means it
 * can end up inside the shipped bundle. Whether or not it does, it is a secret
 * shared between processes on one machine — so it is only ever offered to a
 * gateway on this machine, never to whatever host the build was pointed at.
 *
 * "This machine" is decided by the same fence the extension and the Pages app use.
 */
import { normalizeLoopbackBaseUrl } from "@opensesame/api-client";

export function isLoopbackUrl(raw: string): boolean {
  return normalizeLoopbackBaseUrl(raw) !== null;
}

export function operatorHeadersFor(
  base: string,
  operatorToken: string,
): Record<string, string> {
  if (!operatorToken || !isLoopbackUrl(base)) return {};
  return { authorization: `Bearer operator:${operatorToken}` };
}
