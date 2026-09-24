/**
 * The one check for a caller-supplied post-login destination. A raw-string
 * test is not enough: the WHATWG URL parser a browser runs on `Location`
 * strips tab and newline, treats `\` as `/` and collapses `..`, so a value
 * like "/\t/evil.example" or "/..//evil.example" passes a prefix check and
 * then lands off-site. The value is therefore refused if it (or its decoded
 * form) carries a control character, whitespace or a backslash, and is then
 * resolved against a fixed origin the way a browser would; only a same-origin
 * result whose path is not protocol-relative is kept, as path + query.
 */

/** Controls (C0, DEL, C1), format characters, every space, and a backslash. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Z}\\]/u;

const ABSOLUTE_HTTP = /^https?:\/\//iu;

const MAX_LENGTH = 2048;

function hasUnsafeChars(value: string): boolean {
  if (UNSAFE_CHARS.test(value)) return true;
  try {
    return UNSAFE_CHARS.test(decodeURIComponent(value));
  } catch {
    return true;
  }
}

function resolve(value: string, base: URL): URL | undefined {
  try {
    return new URL(value, base);
  } catch {
    return undefined;
  }
}

function isProtocolRelative(pathname: string): boolean {
  if (pathname.startsWith("//")) return true;
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.startsWith("//") || decoded.includes("\\");
  } catch {
    return true;
  }
}

export type SameOriginPathOptions = {
  /** Also admit an absolute `http(s)://` URL naming exactly `origin`. */
  readonly allowAbsolute?: boolean;
};

/**
 * `value` as a same-origin `pathname + search` under `origin`, or `undefined`.
 * Only a path starting with a single "/" is accepted unless `allowAbsolute`
 * admits an absolute URL, which must then name exactly `origin`.
 */
export function sameOriginPath(
  value: string,
  origin: string,
  options: SameOriginPathOptions = {},
): string | undefined {
  if (value.length === 0 || value.length > MAX_LENGTH) return undefined;
  if (hasUnsafeChars(value)) return undefined;
  const relative = value.startsWith("/") && !value.startsWith("//");
  const absolute = options.allowAbsolute === true && ABSOLUTE_HTTP.test(value);
  if (!relative && !absolute) return undefined;
  const base = resolve("/", new URL(origin));
  const target = base ? resolve(value, base) : undefined;
  if (!base || !target || target.origin !== base.origin) return undefined;
  if (isProtocolRelative(target.pathname)) return undefined;
  return `${target.pathname}${target.search}`;
}
