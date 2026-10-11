/**
 * RFC 8707 resource indicators: one canonical spelling per resource, so two
 * spellings of a host cannot be two resources.
 *
 * A key is audience-bound by comparing strings. That is only safe if the
 * strings are canonical, and canonical here is strict: https, a lower-case
 * ASCII host with no userinfo, no default port, no query, no fragment, no dot
 * segments and no trailing slash. Anything else is refused rather than fixed,
 * because a repair that guesses is the way `api.example.com.evil.test` and
 * `api.example.com@evil.test` come to mean the same thing.
 */
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { refuse } from "./errors.js";

const SCHEME = "https://";
const MAX_LENGTH = 512;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=:@-]+$/;

/** Control characters and space, DEL, a backslash or a percent: nothing a canonical URL may spell. */
function hasForbiddenCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c || code === 0x25)
      return true;
  }
  return false;
}

/** A non-empty string no longer than a resource may be. */
function isBoundedString(value: BoundaryValue): value is string {
  return isString(value) && value.length > 0 && value.length <= MAX_LENGTH;
}

function parseResource(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return refuse("invalid_target", "resource.parse");
  }
}

/** Parts `new URL` found that a canonical resource never carries. */
function hasParsedParts(url: URL): boolean {
  return [url.username, url.password, url.search, url.hash, url.port].some(
    (part) => part !== "",
  );
}

/** `new URL` would repair these; canonical means they were never written. */
function hasWrittenParts(rest: string): boolean {
  return ["?", "#", "@"].some((mark) => rest.includes(mark));
}

/** Split what follows the scheme into its host and its path (empty, or beginning with `/`). */
function splitAuthority(rest: string) {
  const slash = rest.indexOf("/");
  return slash === -1
    ? { host: rest, path: "" }
    : { host: rest.slice(0, slash), path: rest.slice(slash) };
}

function isCanonicalHost(host: string, url: URL): boolean {
  return host === host.toLowerCase() && HOST.test(host) && host === url.host;
}

function isCanonicalSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    PATH_SEGMENT.test(segment)
  );
}

/** A path is empty or `/a/b`: no trailing slash, no empty, dot or odd segment. */
function checkPath(path: string): void {
  if (path === "/") refuse("invalid_target", "resource.trailing_slash");
  if (path !== "" && !path.slice(1).split("/").every(isCanonicalSegment))
    refuse("invalid_target", "resource.path");
}

export function canonicalResource(value: BoundaryValue): string {
  if (!isBoundedString(value))
    return refuse("invalid_target", "resource.shape");
  if (hasForbiddenCharacter(value) || !value.startsWith(SCHEME))
    return refuse("invalid_target", "resource.scheme");
  const url = parseResource(value);
  const rest = value.slice(SCHEME.length);
  if (hasParsedParts(url) || hasWrittenParts(rest))
    return refuse("invalid_target", "resource.parts");
  const { host, path } = splitAuthority(rest);
  if (!isCanonicalHost(host, url))
    return refuse("invalid_target", "resource.host");
  checkPath(path);
  return `${SCHEME}${host}${path}`;
}

/** Is `candidate` inside `base`, on a path-segment boundary? */
export function insideResource(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`);
}
