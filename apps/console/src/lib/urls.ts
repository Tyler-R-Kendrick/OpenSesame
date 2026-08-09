/**
 * The console's operator bearer comes from a build-time variable, which means it
 * can end up inside the shipped bundle. Whether or not it does, it is a secret
 * shared between processes on one machine — so it is only ever offered to a
 * gateway on this machine, never to whatever host the build was pointed at.
 */

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

export function operatorHeadersFor(
  base: string,
  operatorToken: string,
): Record<string, string> {
  if (!operatorToken || !isLoopbackUrl(base)) return {};
  return { authorization: `Bearer operator:${operatorToken}` };
}
