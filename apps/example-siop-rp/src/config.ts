/**
 * RP configuration — override with environment variables for local Pages dev.
 */

import type { SiopIssuerProfile } from "@opensesame/siop-v2";

export type SiopRpConfig = {
  /** Pages origin + optional path prefix (no trailing slash), e.g. https://tyler-r-kendrick.github.io/OpenSesame */
  pagesBase: string;
  /** Pre-registered local application id (must match Pages › Access › Applications). */
  clientId: string;
  /** Exact redirect URI registered for that application. */
  redirectUri: string;
  /** HTTP listen host:port for this example RP (display / env form). */
  listen: string;
  host: string;
  port: number;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function loadSiopRpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SiopRpConfig {
  const pagesBase = trimTrailingSlashes(
    env.OPENSESAME_PAGES_BASE?.trim() || "http://localhost:5180/OpenSesame",
  );
  const listen = env.SIOP_RP_LISTEN?.trim() || "127.0.0.1:4110";
  const colon = listen.lastIndexOf(":");
  const host = colon > 0 ? listen.slice(0, colon) : "127.0.0.1";
  const portRaw = colon > 0 ? listen.slice(colon + 1) : listen;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SIOP_RP_LISTEN must be host:port, got ${listen}`);
  }
  const redirectUri =
    env.SIOP_RP_REDIRECT_URI?.trim() ||
    new URL("/callback", `http://${listen}`).href;
  const clientId =
    env.SIOP_RP_CLIENT_ID?.trim() ||
    "local_00000000-0000-4000-8000-000000000001";
  return { pagesBase, clientId, redirectUri, listen, host, port };
}

/** Dynamic Self-Issued issuer on the Pages origin (`…/identity/siop`). */
export function dynamicSiopIssuer(pagesBase: string): string {
  return `${trimTrailingSlashes(pagesBase)}/identity/siop`;
}

export function pagesSiopIssuerProfile(pagesBase: string): SiopIssuerProfile {
  return { kind: "dynamic", issuer: dynamicSiopIssuer(pagesBase) };
}
