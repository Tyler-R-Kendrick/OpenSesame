/**
 * Which origins the runner will drive, and what a URL may be.
 *
 * A run is scoped to one origin (ADR 0082 §4). That origin is the whole of the
 * runner's authority: it navigates only within it, injects only into it, and
 * the browser's host permission it holds is for it and nothing else.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The exact origin of `value`, or null for anything that is not an http(s) origin. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Whether the runner may drive `origin` at all: HTTPS, or HTTP on this
 * machine. Cleartext to anywhere else would hand a credential to the network.
 */
export function drivable(origin: string): boolean {
  const normalized = originOf(origin);
  if (normalized === null || normalized !== origin) return false;
  const url = new URL(origin);
  return url.protocol === "https:" || LOOPBACK.has(url.hostname);
}

/** `url` resolved against nothing: it must be absolute, and inside `origin`. */
export function withinOrigin(url: string, origin: string): boolean {
  return originOf(url) === origin;
}

/** The browser match pattern that grants exactly `origin`. */
export function matchPattern(origin: string): string {
  return `${origin}/*`;
}
