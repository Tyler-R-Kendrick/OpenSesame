/**
 * The line a person pastes into a request. An API key travels in the header the
 * account names (`X-Api-Key: …`) and a token as a bearer (`Authorization:
 * Bearer …`): the form a client library, a proxy's config and an HTTP tool all
 * take. Copying a credential whole puts this on the clipboard; copying one of
 * its values puts that value alone.
 */

import type { AccountItem } from "./account.js";

const DEFAULT_HEADER = "X-Api-Key";

/** The header name as written, without a stray colon, or the usual one. */
export function headerName(header: string): string {
  const name = header.trim().replace(/\s*:+$/u, "");
  return name === "" ? DEFAULT_HEADER : name;
}

/** `Header-Name: key`. */
export function apiKeyHeaderLine(header: string, key: string): string {
  return `${headerName(header)}: ${key.trim()}`;
}

/** `Authorization: Bearer token`. */
export function bearerHeaderLine(token: string): string {
  return `Authorization: Bearer ${token.trim()}`;
}

/**
 * What copying an account gives when it has no password: its first API key as
 * a header line, else its first token as a bearer line. An account that has a
 * password gives the password (ADR 0174), so this is `null` for it, and `null`
 * for an account with nothing to paste.
 */
export function credentialLine(item: AccountItem): string | null {
  if (item.methods.some((method) => method.type === "password")) return null;
  for (const method of item.methods) {
    if (method.type === "api-key" && method.key.trim() !== "") {
      return apiKeyHeaderLine(method.header, method.key);
    }
  }
  for (const method of item.methods) {
    if (method.type === "token" && method.token.trim() !== "") {
      return bearerHeaderLine(method.token);
    }
  }
  return null;
}
