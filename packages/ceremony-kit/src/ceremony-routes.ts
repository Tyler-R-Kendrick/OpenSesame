/**
 * The ceremony routes a link can open on the app origin
 * (`spec/config/ceremony-routes.json`, ADR 0139, ADR 0140 §3).
 *
 * Every builder and parser in this package reads its path from here, and so
 * does every other target through its own drift test: the Identity API's
 * short link and launcher, the Android app-link filter, and (later) the Pages
 * route contributions. A path is relative to the deployment's base — Pages
 * serves under `/OpenSesame/` — so a builder prepends the base and a matcher
 * reads the tail of a pathname.
 *
 * Pure data and string work: no globals, no URL parsing, no network.
 */
import { CEREMONY_ROUTES_JSON } from "./ceremony-routes.generated.js";

export type CeremonyRouteId =
  | "interaction"
  | "claim"
  | "device"
  | "approve"
  | "invoke"
  | "guest"
  | "delegate";

export type AuthenticatorInvocationKind = "mfa" | "oid4vp" | "oid4vci";

/** How an `/invoke/{kind}` link hands off to the native authenticator. */
export type InvokeKind = {
  /** The query names that may carry the request handle, exactly one of them. */
  readonly query: readonly string[];
  /** The app link the handle is appended to. */
  readonly app: string;
  /** The app link's parameter name, when it differs from the handle's. */
  readonly appParameter?: string;
  /** The browser ceremony a user code falls back to. */
  readonly fallback?: CeremonyRouteId;
};

export type CeremonyRoute = {
  /** Relative to the deployment base; `{name}` is one path segment. */
  readonly path: string;
  readonly summary: string;
  /** Query names the route reads (display artifacts and handles only). */
  readonly query?: readonly string[];
  /** Fragment names the route reads (a bearer rides only here). */
  readonly fragment?: readonly string[];
  /** A route that is another road under a second name. */
  readonly aliasOf?: string;
  readonly kinds?: Readonly<Record<AuthenticatorInvocationKind, InvokeKind>>;
};

/** A link shape printed before the canonical routes: read, never emitted. */
export type LegacyLinkShape = {
  readonly scheme: string;
  /** `host/path` a custom scheme must carry; absent for http(s). */
  readonly route?: string;
};

export type LegacyLinks = {
  /** The canonical route every legacy link now opens. */
  readonly opens: CeremonyRouteId;
  /** The query names a legacy link carried its user code under, in order. */
  readonly query: readonly string[];
  readonly links: readonly LegacyLinkShape[];
};

const spec: {
  routes: Readonly<Record<CeremonyRouteId, CeremonyRoute>>;
  legacy: LegacyLinks;
} = /* @__PURE__ */ JSON.parse(CEREMONY_ROUTES_JSON);

export const CEREMONY_ROUTES: Readonly<Record<CeremonyRouteId, CeremonyRoute>> =
  spec.routes;

export const LEGACY_LINKS: LegacyLinks = spec.legacy;

const INVOKE_KINDS: Readonly<Record<AuthenticatorInvocationKind, InvokeKind>> =
  CEREMONY_ROUTES.invoke.kinds ??
  ({} as Record<AuthenticatorInvocationKind, InvokeKind>);

/** Every `/invoke/{kind}` kind, in spec order. */
export const AUTHENTICATOR_INVOCATION_KINDS: readonly AuthenticatorInvocationKind[] =
  Object.keys(INVOKE_KINDS) as AuthenticatorInvocationKind[];

/** The hand-off an `/invoke/{kind}` link makes for `kind`. */
export function invokeKind(kind: AuthenticatorInvocationKind): InvokeKind {
  return INVOKE_KINDS[kind];
}

/** True when `value` names an `/invoke/{kind}` kind the spec lists. */
export function isAuthenticatorInvocationKind(
  value: unknown,
): value is AuthenticatorInvocationKind {
  return typeof value === "string" && Object.hasOwn(INVOKE_KINDS, value);
}

const PARAMETER = /^\{(\w+)\}$/;

function segmentsOf(id: CeremonyRouteId): string[] {
  return CEREMONY_ROUTES[id].path.split("/").slice(1);
}

/**
 * The route's path with each `{name}` replaced by `params[name]`,
 * percent-encoded. Throws when a parameter is missing, because a link with
 * an empty segment is a different route, not a partial one.
 */
export function ceremonyPath(
  id: CeremonyRouteId,
  params: Readonly<Record<string, string>> = {},
): string {
  const built = segmentsOf(id).map((segment) => {
    const name = PARAMETER.exec(segment)?.[1];
    if (name === undefined) return segment;
    const value = params[name];
    if (value === undefined || value === "") {
      throw new Error(`The ${id} route needs a ${name}.`);
    }
    return encodeURIComponent(value);
  });
  return `/${built.join("/")}`;
}

/**
 * The route's path in a client router's spelling: each `{name}` becomes the
 * named segment `:name` (`/i/{ref}` → `/i/:ref`), for a drift test against
 * the routes a surface registers.
 */
export function ceremonyRouterPath(id: CeremonyRouteId): string {
  return CEREMONY_ROUTES[id].path.replace(/\{(\w+)\}/g, ":$1");
}

/** The fixed part of a route's path, up to its first parameter. */
export function ceremonyRoutePrefix(id: CeremonyRouteId): string {
  const { path } = CEREMONY_ROUTES[id];
  const open = path.indexOf("{");
  return open === -1 ? path : path.slice(0, open);
}

/**
 * Match the tail of `pathname` against a route, or `null`.
 *
 * The tail, because a deployment's base prefix is its own business. Segments
 * are returned raw — not percent-decoded — so a caller that shape-checks one
 * refuses an encoded `../` instead of repairing it.
 */
export function matchCeremonyPath(
  id: CeremonyRouteId,
  pathname: string,
): Record<string, string> | null {
  const pattern = segmentsOf(id);
  const segments = pathname.split("/");
  if (segments.length <= pattern.length) return null;
  const tail = segments.slice(-pattern.length);
  const params: Record<string, string> = {};
  for (const [index, want] of pattern.entries()) {
    const got = tail[index] ?? "";
    const name = PARAMETER.exec(want)?.[1];
    if (name === undefined) {
      if (got !== want) return null;
    } else if (got === "") {
      return null;
    } else {
      params[name] = got;
    }
  }
  return params;
}
