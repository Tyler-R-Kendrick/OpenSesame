/**
 * Relying-party configuration, read from the environment.
 *
 * Everything here is something the RP's operator decides. What the person
 * decides is on the other side: they register `SIOP_RP_CLIENT_ID` and the
 * exact redirect URIs in their own Pages vault (Identity › Applications).
 */
import { pagesOriginOf, pagesSiopIssuer } from "@opensesame/siop-v2";

export type SiopRpConfig = {
  /** Pages origin + optional path prefix, e.g. https://tyler-r-kendrick.github.io/OpenSesame */
  pagesBase: string;
  /** The default application id the person registers (`local_<uuid>`). */
  clientId: string;
  /** The primary redirect URI, exactly as registered (a query is part of it). */
  redirectUri: string;
  /**
   * Every path that serves the callback page. The first is the primary
   * redirect URI's own. Each extra path is a further registered callback
   * (`origin + path`) a login may be started for with `/auth/start?callback=`;
   * a response that lands on a callback its login was not started for is
   * refused.
   */
  callbackPaths: string[];
  /** Every redirect URI a login may name: the primary and the extras. */
  redirectUris: string[];
  /** Read the deployment's metadata document at startup and use what it names. */
  discover: boolean;
  /** Where to fetch that document from; defaults to beside the issuer. */
  metadataUrl: string | undefined;
  /** The document is a mirror, on another origin than the issuer. */
  metadataMirror: boolean;
  /** Accept loopback `http` URLs: local development only. */
  allowLoopbackHttp: boolean;
  /** Logins one client may start per minute. */
  startsPerMinute: number;
  /** Logins that may wait at once before new ones are refused. */
  maxPendingLogins: number;
  /** host:port, for display. */
  listen: string;
  host: string;
  port: number;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function listFrom(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `host:port` from `SIOP_RP_LISTEN`; port 0 asks the kernel for one (tests). */
function listenOf(env: NodeJS.ProcessEnv) {
  const listen = env.SIOP_RP_LISTEN?.trim() || "127.0.0.1:4110";
  const colon = listen.lastIndexOf(":");
  const host = colon > 0 ? listen.slice(0, colon) : "127.0.0.1";
  const port = Number(colon > 0 ? listen.slice(colon + 1) : listen);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`SIOP_RP_LISTEN must be host:port, got ${listen}`);
  }
  return { listen, host, port };
}

export function loadSiopRpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SiopRpConfig {
  const pagesBase = trimTrailingSlashes(
    env.OPENSESAME_PAGES_BASE?.trim() ||
      "https://tyler-r-kendrick.github.io/OpenSesame",
  );
  const { listen, host, port } = listenOf(env);
  const redirectUri =
    env.SIOP_RP_REDIRECT_URI?.trim() ||
    new URL("/callback", `http://${listen}`).href;
  const clientId =
    env.SIOP_RP_CLIENT_ID?.trim() ||
    "local_00000000-0000-4000-8000-000000000001";
  const primary = new URL(redirectUri);
  const extra = listFrom(env.SIOP_RP_CALLBACK_PATHS).filter(
    (path) => path !== primary.pathname,
  );
  return {
    pagesBase,
    clientId,
    redirectUri,
    callbackPaths: [primary.pathname, ...extra],
    redirectUris: [
      redirectUri,
      ...extra.map((path) => `${primary.origin}${path}`),
    ],
    discover: env.SIOP_RP_DISCOVER === "1",
    metadataUrl: env.SIOP_RP_METADATA_URL?.trim() || undefined,
    metadataMirror: env.SIOP_RP_METADATA_MIRROR === "1",
    allowLoopbackHttp: env.SIOP_RP_ALLOW_LOOPBACK_HTTP === "1",
    startsPerMinute: positiveInt(env.SIOP_RP_STARTS_PER_MINUTE, 30),
    maxPendingLogins: positiveInt(env.SIOP_RP_MAX_PENDING_LOGINS, 10_000),
    listen,
    host,
    port,
  };
}

/** The issuer a Pages deployment signs as: its origin, base path and consent route. */
export function issuerOf(config: SiopRpConfig): string {
  return pagesSiopIssuer(pagesOriginOf(config.pagesBase));
}
