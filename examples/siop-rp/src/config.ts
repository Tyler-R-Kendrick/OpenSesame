/**
 * Relying-party configuration, read from the environment.
 *
 * Everything here is something the RP's operator decides. What the person
 * decides is on the other side: they register `SIOP_RP_CLIENT_ID` and the
 * exact redirect URI in their own Pages vault (Identity › Applications).
 */
import { pagesOriginOf, pagesSiopIssuer } from "@opensesame/siop-v2";

export type SiopRpConfig = {
  /** Pages origin + optional path prefix, e.g. https://tyler-r-kendrick.github.io/OpenSesame */
  pagesBase: string;
  /** The application id the person registers (`local_<uuid>`). */
  clientId: string;
  /** The exact redirect URI the login sends; registered in the person's vault. */
  redirectUri: string;
  /**
   * Every path that serves the callback page. The first is the redirect URI's
   * own; a response that arrives on another is refused unless the login was
   * started for it (a second registered callback, say a mobile one).
   */
  callbackPaths: string[];
  /** Read the deployment's metadata document at startup and use what it names. */
  discover: boolean;
  /** Where to fetch that document from; defaults to beside the issuer. */
  metadataUrl: string | undefined;
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
  const own = new URL(redirectUri).pathname;
  const extra = listFrom(env.SIOP_RP_CALLBACK_PATHS).filter(
    (path) => path !== own,
  );
  return {
    pagesBase,
    clientId,
    redirectUri,
    callbackPaths: [own, ...extra],
    discover: env.SIOP_RP_DISCOVER === "1",
    metadataUrl: env.SIOP_RP_METADATA_URL?.trim() || undefined,
    listen,
    host,
    port,
  };
}

/** The issuer a Pages deployment signs as: its origin, base path and consent route. */
export function issuerOf(config: SiopRpConfig): string {
  return pagesSiopIssuer(pagesOriginOf(config.pagesBase));
}
