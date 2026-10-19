import type { NativeFetchRequest } from "./bitwarden-native-network-protocol.js";
import { secretBackendUrl } from "./http.js";
import { SecretBackendError } from "./types.js";

const UUID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CIPHER = new RegExp(`^ciphers/${UUID}$`);
const TRASH = new RegExp(`^ciphers/${UUID}/delete$`);
type Route = { maximum: number; media: string | null; authenticated: boolean };
function refused(): never {
  throw new SecretBackendError(
    "network",
    "The native account worker requested an unapproved endpoint.",
  );
}
function relative(target: URL, base: URL): string | undefined {
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(base.pathname)
  )
    return undefined;
  return target.pathname.slice(base.pathname.length);
}
function identityRoute(
  request: NativeFetchRequest,
  target: URL,
  identity: URL,
): Route | null {
  const authPath = relative(target, identity);
  if (request.method === "POST" && !target.search) {
    if (authPath === "connect/token")
      return {
        maximum: 64 * 1024,
        media: "application/x-www-form-urlencoded",
        authenticated: false,
      };
    if (
      ["accounts/prelogin", "accounts/prelogin/password"].includes(
        authPath ?? "",
      )
    )
      return {
        maximum: 64 * 1024,
        media: "application/json",
        authenticated: false,
      };
  }
  return null;
}
function route(
  request: NativeFetchRequest,
  target: URL,
  api: URL,
  identity: URL,
): Route {
  const auth = identityRoute(request, target, identity);
  if (auth) return auth;
  const path = relative(target, api);
  if (
    request.method === "GET" &&
    path === "sync" &&
    target.search === "?excludeDomains=true"
  )
    return { maximum: 64 * 1024 * 1024, media: null, authenticated: true };
  if (!path || target.search) return refused();
  if (request.method === "GET" && CIPHER.test(path))
    return { maximum: 8 * 1024 * 1024, media: null, authenticated: true };
  if (
    (request.method === "POST" && path === "ciphers") ||
    (request.method === "PUT" && CIPHER.test(path))
  )
    return {
      maximum: 8 * 1024 * 1024,
      media: "application/json",
      authenticated: true,
    };
  if (request.method === "PUT" && TRASH.test(path))
    return { maximum: 0, media: null, authenticated: true };
  return refused();
}
function validateHeaders(request: NativeFetchRequest, allowed: Route): void {
  const names = request.headers.map(([name]) => name.toLowerCase());
  if (
    new Set(names).size !== names.length ||
    names.some(
      (name) => !["authorization", "content-type", "accept"].includes(name),
    )
  )
    refused();
  const headers = new Headers(request.headers);
  const authorization = headers.get("authorization");
  if (
    allowed.authenticated
      ? !/^Bearer [A-Za-z0-9\-._~+/]+=*$/.test(authorization ?? "")
      : authorization !== null
  )
    refused();
  const media =
    headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  if (
    media !== allowed.media ||
    (allowed.media === null && request.body !== "")
  )
    refused();
}
/** Immutable tenant prefixes and a fixed personal-account API, never an arbitrary HTTP proxy. */
export function bitwardenNativeNetworkPolicy(
  baseUrl: string,
  identityUrl: string,
) {
  const api = secretBackendUrl(baseUrl);
  const identity = secretBackendUrl(identityUrl);
  return (request: NativeFetchRequest): number => {
    const target = new URL(request.url);
    if (
      target.href !== request.url ||
      target.username ||
      target.password ||
      target.hash
    )
      return refused();
    const allowed = route(request, target, api, identity);
    validateHeaders(request, allowed);
    const size = new TextEncoder().encode(request.body).length;
    if (size > (allowed.authenticated ? 8 * 1024 * 1024 : 64 * 1024))
      return refused();
    return allowed.maximum;
  };
}
