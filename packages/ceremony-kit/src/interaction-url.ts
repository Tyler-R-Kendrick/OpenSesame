import { FORBIDDEN_URL_PARAMS, isString } from "@opensesame/os-domain";
/**
 * The canonical cross-device interaction link (ADR 0086).
 *
 * One link format, built and read in one place. Before this module the same
 * knowledge lived in four surfaces at once — the ceremonies app built one
 * shape, mobile-MFA parsed another, Pages rendered a third, and the CLI
 * printed a fourth — which meant four independent chances to put credential
 * material in a URL, four expiry stories, and four answers to "is this link
 * even ours?". A link is the least defensible place a secret can end up: it is
 * photographed off screens, pasted into chats, written to browser history,
 * replayed from `Referer`, and logged verbatim by every proxy on the path.
 *
 * The link therefore carries exactly one thing — an opaque, MAC-bound
 * interaction reference — and the reference authorizes nothing on its own
 * (see `@opensesame/os-domain`'s `crypto/interaction-ref.ts`). Scanning is not
 * approving. Everything in this file exists to keep that true: the builder
 * refuses to emit anything but the reference, and the parser refuses to
 * recognise anything but the canonical shape.
 *
 * Framework-, storage- and network-free by design: this module touches no
 * globals, so the same code runs in a service worker, a React Native shell, a
 * Node CLI, and a QR encoder.
 */

/** Why a link was refused. Stable, so surfaces can branch without regexing. */
export type InteractionLinkErrorReason =
  | "malformed_base"
  | "insecure_transport"
  | "base_carries_userinfo"
  | "base_carries_parameters"
  | "malformed_ref"
  | "forbidden_parameter"
  | "deny_list_unavailable";

/**
 * A link that must not exist.
 *
 * Separate from `CeremonyRequestError` on purpose: that one reports what a
 * server said, this one reports that we were about to do something unsafe
 * ourselves. The two need different handling — one is retried, the other is a
 * bug or an attack.
 */
export class InteractionLinkError extends Error {
  readonly reason: InteractionLinkErrorReason;
  constructor(reason: InteractionLinkErrorReason, message: string) {
    super(message);
    this.name = "InteractionLinkError";
    this.reason = reason;
  }
}

/**
 * Shape of an interaction reference: `i_<base64url>.<tag>`.
 *
 * Only the *shape* is checked here. The tag's real length and its MAC are the
 * minting server's business and cannot be verified without the pepper, so a
 * client that pinned the exact tag length would break the moment the server
 * rotated its parameters. What the client must enforce is that the reference
 * is base64url and nothing else, because that is what stops `../`, a second
 * `?`, a percent-encoded slash, or 10 KB of junk from reaching a URL path or
 * an HTTP request line through a slot that looks like an identifier.
 */
const REF_PATTERN = /^i_[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{16,128}$/;

/**
 * Ceiling on any URL this module will look at.
 *
 * Hostile input arrives as length far more often than as cleverness: a
 * megabyte of `?` in a scanned payload costs nothing to send and would
 * otherwise be parsed, split, and regexed. Refusing early makes the parser's
 * cost bounded by a constant.
 */
const MAX_URL_LENGTH = 2048;

/** Upper bound for a legacy user code, matching the ceremonies app's handles. */
const MAX_USER_CODE_LENGTH = 64;

/** A user code is a display artifact, so its alphabet is display-safe too. */
const USER_CODE_PATTERN = /^[A-Z0-9._-]{1,64}$/;

/**
 * The three spellings of "this machine".
 *
 * Deliberately literal. `.localhost` subdomains, `10.`/`192.168.`/`172.16.`
 * addresses, `169.254.` link-local, `*.local` mDNS names and tailnet names are
 * all excluded even though a developer might reach a dev server on any of
 * them, because every one of those still puts the link on a wire.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
]);

/**
 * The deny-list, normalized once.
 *
 * `FORBIDDEN_URL_PARAMS` is imported rather than restated: a second copy of
 * this list is a second thing to forget to update, and the whole point of the
 * list is that it is exhaustive. It is normalized so one entry covers every
 * casing a caller might reach for — `access_token`, `accessToken`,
 * `Access-Token` and `ACCESS_TOKEN` are the same parameter to anything that
 * reads URLs, and an attacker choosing between them is choosing for free.
 */
function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[_\-.\s]/g, "");
}

const DENY_LIST: ReadonlySet<string> = new Set(
  Array.isArray(FORBIDDEN_URL_PARAMS)
    ? FORBIDDEN_URL_PARAMS.map(normalizeParamName)
    : [],
);

/**
 * Refuse to certify a link when the deny-list did not load.
 *
 * This is not hypothetical. `FORBIDDEN_URL_PARAMS` lives beside the reference
 * minting code in `@opensesame/os-domain`'s Node entry, and browser surfaces
 * (`apps/pages` aliases the package straight to `src/browser.ts`) resolve a
 * surface that does not re-export it. An empty deny-list would silently mean
 * "nothing is forbidden", which is the worst possible failure mode for a check
 * whose entire job is to say no. Failing closed turns that into a loud,
 * one-line fix in the domain package's browser surface instead of a bearer on
 * a screen.
 */
function assertDenyListLoaded(): void {
  if (DENY_LIST.size === 0) {
    throw new InteractionLinkError(
      "deny_list_unavailable",
      "The forbidden-parameter list is unavailable, so this link cannot be checked.",
    );
  }
}

/**
 * Every parameter name anywhere in a URL's query or fragment.
 *
 * Scans the raw string rather than a parsed `URL`, for two reasons: the check
 * must work on input that does not parse at all (a truncated QR, a hand-typed
 * scheme), and `URL` normalization can move or drop material a downstream
 * consumer would still see.
 *
 * The section is split on every `?`, `#`, `&` and `;` rather than handed to a
 * single `URLSearchParams`. That parser reads a section as one flat key/value
 * list, so it stops finding names the moment a separator appears inside a
 * value: `#/approve?b=1#token=leak` parses as one pair named `b` whose value
 * merely contains `token=leak`, and the token walks straight through.
 * Single-page routers write exactly that shape, and a token in it is every bit
 * as readable to whoever holds the URL as one in the query string.
 *
 * Names are percent-decoded, because `%61ccess_token` is `access_token` to
 * everything downstream, and leading slashes are stripped so a router path
 * segment cannot disguise one.
 */
function parameterNames(section: string): string[] {
  if (section.length === 0) return [];
  const names: string[] = [];
  for (const segment of section.split(/[?#&;]/)) {
    const equals = segment.indexOf("=");
    if (equals <= 0) continue;
    const raw = segment.slice(0, equals).replace(/^\/+/, "");
    let name = raw;
    try {
      name = decodeURIComponent(raw.replace(/\+/g, " "));
    } catch {
      // A malformed escape is not a reason to stop checking: fall back to the
      // raw name so the deny-list still has something to match.
      name = raw;
    }
    names.push(name);
  }
  return names;
}

/**
 * The two places a URL can hide a parameter.
 *
 * Named rather than inlined because both halves are checked by the same
 * deny-list: a credential smuggled after `#` never reaches a server, but it
 * does reach every client-side router that reads `location.hash`, so the
 * fragment is not the safer half and must not read as an afterthought.
 */
interface ParameterSections {
  query: string;
  fragment: string;
}

function splitParameterSections(url: string): ParameterSections {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  return { query, fragment };
}

function assertNoForbiddenParamsExcept(
  url: string,
  exempt: ReadonlySet<string>,
): void {
  assertDenyListLoaded();
  const { query, fragment } = splitParameterSections(url);
  for (const section of [query, fragment]) {
    for (const name of parameterNames(section)) {
      const normalized = normalizeParamName(name);
      if (exempt.has(normalized)) continue;
      if (DENY_LIST.has(normalized)) {
        throw new InteractionLinkError(
          "forbidden_parameter",
          "This link carries credential material and was refused.",
        );
      }
    }
  }
}

/**
 * Refuse a URL whose query or fragment names credential material.
 *
 * Runs inside `buildInteractionUrl`, which is what makes the guarantee
 * structural rather than a convention: a caller cannot assemble a base URL
 * with `?access_token=…` and have an interaction link come out the other side,
 * and — because `@opensesame/qr` calls this before encoding — cannot get a QR
 * of one either. Matching is case-insensitive and separator-insensitive, so
 * `access_token`, `accessToken` and `Access-Token` are one rule.
 *
 * The error message is deliberately generic. Naming the offending parameter
 * would put it in whatever log or toast renders the message, which is the
 * thing this function exists to prevent.
 */
export function assertNoForbiddenParams(url: string): void {
  assertNoForbiddenParamsExcept(url, new Set());
}

/** True when `ref` has the canonical `i_<base64url>.<tag>` shape. */
export function isInteractionRef(ref: string): boolean {
  return REF_PATTERN.test(ref);
}

/**
 * True for the three host spellings that never leave the machine.
 *
 * **Why the plaintext exception is safe here.** TLS on an interaction link
 * defends against an attacker on the network path: someone who can read or
 * rewrite the bytes between the two devices. For `127.0.0.1` and `[::1]` there
 * is no such path — the kernel loops the packets back without ever reaching an
 * interface — so the threat TLS answers does not exist, and requiring
 * certificates would only push developers toward disabled verification, which
 * is strictly worse.
 *
 * **Where it is not safe.** (1) It is not a "private addresses are fine" rule:
 * `10.0.0.5`, `192.168.1.10`, `169.254.169.254` and a tailnet name all cross a
 * wire and are refused here — see `apps/ceremonies/src/lib/authenticator-link.ts`,
 * whose `privateHost()` refuses that whole range for the same reason from the
 * other direction. (2) `localhost` is a *name*, not an address, and a host
 * whose resolver or hosts file has been tampered with can point it anywhere;
 * it is admitted only because browser cookie scoping and dev tooling depend on
 * it, and it is the weakest of the three. (3) Loopback keeps the link off the
 * network, not away from the machine: any other local process, browser
 * extension, or user on that host can still read it, so this is a
 * developer-workstation affordance and never a production posture.
 */
function isLoopbackLiteral(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function isAcceptableTransport(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackLiteral(url.hostname);
}

/**
 * Build the canonical link for an interaction: `<base>/i/<ref>`.
 *
 * Everything the receiving surface needs is in the path, so the query string
 * and the fragment stay empty and stay that way — a link with no parameters
 * has nowhere to hide a bearer, and `assertNoForbiddenParams` runs on both the
 * base and the finished link to keep it that way even if a future caller
 * decides otherwise.
 *
 * Throws `InteractionLinkError` for a base that is not parseable, is not
 * HTTPS (loopback excepted, see `isLoopbackLiteral`), carries userinfo — which
 * proxies log and which browsers have historically rendered as part of a
 * spoofed hostname — or already carries a query or fragment, and for a
 * reference that is not `i_<base64url>.<tag>` shaped.
 */
export function buildInteractionUrl(baseUrl: string, ref: string): string {
  assertNoForbiddenParams(baseUrl);
  if (baseUrl.length > MAX_URL_LENGTH) {
    throw new InteractionLinkError(
      "malformed_base",
      "The interaction base URL is malformed.",
    );
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new InteractionLinkError(
      "malformed_base",
      "The interaction base URL is malformed.",
    );
  }
  if (!isAcceptableTransport(base)) {
    throw new InteractionLinkError(
      "insecure_transport",
      "An interaction link must be HTTPS, except against a loopback host.",
    );
  }
  if (base.username !== "" || base.password !== "") {
    throw new InteractionLinkError(
      "base_carries_userinfo",
      "An interaction base URL must not carry userinfo.",
    );
  }
  if (base.search !== "" || base.hash !== "") {
    throw new InteractionLinkError(
      "base_carries_parameters",
      "An interaction base URL must not carry a query or fragment.",
    );
  }
  if (!isInteractionRef(ref)) {
    throw new InteractionLinkError(
      "malformed_ref",
      "That is not an interaction reference.",
    );
  }
  // `URL` has already collapsed `.`/`..` and normalized the path, so the
  // prefix cannot climb out of the deployment's base (Pages serves under
  // `/OpenSesame/`). Trailing slashes are stripped so `https://x/` and
  // `https://x` produce one spelling — an audit trail split across two
  // spellings of the same link is an audit trail that cannot be joined.
  const prefix = base.pathname.replace(/\/+$/, "");
  const built = `${base.origin}${prefix}/i/${ref}`;
  assertNoForbiddenParams(built);
  return built;
}

/**
 * Read a canonical interaction link, or `null`.
 *
 * Never throws. This runs on whatever a camera decoded, a user pasted, or a
 * push payload contained, and a parser that throws on hostile input is a
 * denial-of-service surface on the one code path that must survive garbage.
 * Every rejection is the same `null`, so the caller has exactly one branch and
 * cannot accidentally treat "wrong origin" as more recoverable than "not a
 * link at all".
 *
 * Strict on purpose: a query string, a fragment, userinfo, a percent-encoded
 * reference, or a non-canonical path all return `null` rather than being
 * repaired. Repairing a link means guessing what the sender meant, and the
 * sender may be an attacker.
 */
export function parseInteractionUrl(
  url: string,
): { origin: string; ref: string } | null {
  // Typed `string`, but this is the entry point a plain-JS caller reaches —
  // a service worker message, a deep-link handler, a decoded QR payload — so
  // the contract is re-established at runtime rather than assumed.
  if (!isString(url)) return null;
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    // A protocol-relative `//evil/i/x` has no scheme and no base, so this
    // throws rather than inheriting an origin — which is exactly right: the
    // origin is the only thing that says whose interaction this is.
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isAcceptableTransport(parsed)) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const segments = parsed.pathname.split("/");
  const ref = segments.pop();
  const marker = segments.pop();
  if (marker !== "i") return null;
  if (ref === undefined || !isInteractionRef(ref)) return null;
  // The origin is returned rather than the whole prefix because the origin is
  // the security-relevant half: it is what a surface compares against the host
  // it is willing to answer. The path prefix is a deployment detail the
  // surface already knows about itself.
  return { origin: parsed.origin, ref };
}

/** A user code recovered from a link that predates the canonical format. */
export interface LegacyInteractionLink {
  userCode: string;
}

/**
 * `code` is on the deny-list as an OAuth authorization code — a bearer. It is
 * exempted *only* here, because mobile-MFA shipped `?code=` as an alias for
 * the *user* code, which is a short display artifact that authorizes nothing.
 * The exemption is one-way: `buildInteractionUrl` still refuses to emit
 * `?code=` in any spelling, so the ambiguity dies with the links already
 * printed instead of being carried into the canonical format.
 */
const LEGACY_EXEMPT: ReadonlySet<string> = new Set([
  normalizeParamName("code"),
]);

/**
 * Recognise the interaction links that predate the canonical format.
 *
 * **This is an adapter, not a second canonical format.** Nothing in
 * OpenSesame emits these shapes any more; they exist on cards already
 * printed, in wallet passes already issued, and in mobile deep-link handlers
 * already registered on people's phones. New links are built by
 * `buildInteractionUrl` and read by `parseInteractionUrl` — do not extend
 * this function to make a new shape "work".
 *
 * The four shapes still in the wild:
 * - `https://…?user_code=…` — the ceremonies app's browser fallback
 * - `https://…?code=…` — mobile-MFA's alias for the same value
 * - `opensesame://invoke/mfa?user_code=…` — the authenticator deep link
 * - `opensesame-mfa://approve?user_code=…` — the mobile-MFA scheme
 *
 * Returns `null` when the href simply is not one of them — absence is not an
 * error, and the caller usually has other things to try. It *throws*
 * `InteractionLinkError` when the href carries credential material, because
 * that is a different fact: a link that should never have been created has
 * reached a surface, and swallowing it as `null` would let it be retried,
 * logged, or handed to the next parser.
 */
export function parseLegacyInteractionLink(
  href: string,
): LegacyInteractionLink | null {
  // Same reason as `parseInteractionUrl`: deep-link handlers registered on
  // people's phones call this with whatever the OS handed them.
  if (!isString(href)) return null;
  if (href.length === 0 || href.length > MAX_URL_LENGTH) return null;
  assertNoForbiddenParamsExcept(href, LEGACY_EXEMPT);
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  const route = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  switch (parsed.protocol) {
    case "https:":
    case "http:":
      break;
    case "opensesame:":
      if (route !== "invoke/mfa") return null;
      break;
    case "opensesame-mfa:":
      if (route !== "approve") return null;
      break;
    default:
      return null;
  }
  const raw =
    parsed.searchParams.get("user_code") ?? parsed.searchParams.get("code");
  if (raw === null) return null;
  // Uppercase and trim exactly as `parseUserCode` does, so a code copied with
  // stray whitespace or typed in lower case still matches the one the device
  // is showing. The alphabet is then pinned: a legacy link is attacker-authored
  // input that ends up in a request body and, on some surfaces, on a screen.
  const userCode = raw.trim().toUpperCase();
  if (userCode.length === 0 || userCode.length > MAX_USER_CODE_LENGTH) {
    return null;
  }
  if (!USER_CODE_PATTERN.test(userCode)) return null;
  return { userCode };
}
