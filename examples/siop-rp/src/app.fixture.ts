import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildSelfIssuedIdToken,
  ecP256JwkThumbprint,
  exportPublicEcP256Jwk,
} from "@opensesame/siop-v2";
import { generateKeyPair } from "jose";
import { type SiopRpAppOptions, createSiopRpApp } from "./app.js";
import { type SiopRpConfig, issuerOf, loadSiopRpConfig } from "./config.js";

/** Shared by the relying-party app suites; not a test of its own. */
export const PAGES = "https://pages.example/OpenSesame";
export const CLIENT = "local_00000000-0000-4000-8000-000000000001";

const open: Server[] = [];

export async function closeServers(): Promise<void> {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done());
        }),
    ),
  );
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, "127.0.0.1", ready));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  // SAFETY: the node:net Server contract returns an AddressInfo once listen(0, host) has completed, and this probe listens on 127.0.0.1.
  const { port } = address as AddressInfo;
  return port;
}

export async function relyingParty(
  env: Record<string, string> = {},
  options: SiopRpAppOptions = {},
) {
  const port = await freePort();
  // A redirect given as a bare path is put on this server's own address.
  const asked = env.SIOP_RP_REDIRECT_URI ?? "";
  const config: SiopRpConfig = loadSiopRpConfig({
    OPENSESAME_PAGES_BASE: PAGES,
    SIOP_RP_CLIENT_ID: CLIENT,
    SIOP_RP_LISTEN: `127.0.0.1:${port}`,
    SIOP_RP_CALLBACK_PATHS: "/callback,/callback/mobile",
    SIOP_RP_ALLOW_LOOPBACK_HTTP: "1",
    ...env,
    SIOP_RP_REDIRECT_URI: asked.startsWith("/")
      ? `http://127.0.0.1:${port}${asked}`
      : asked,
  });
  const server = createServer(createSiopRpApp(config, options));
  await new Promise<void>((ready) => server.listen(port, "127.0.0.1", ready));
  open.push(server);
  return { config, base: `http://127.0.0.1:${port}` };
}

/** Start a login the way a browser would: what Pages is sent, and the cookie kept. */
export async function start(base: string, query = "") {
  const response = await fetch(`${base}/auth/start${query}`, {
    redirect: "manual",
  });
  const location = response.headers.get("location") ?? "";
  const url = location === "" ? null : new URL(location);
  return {
    status: response.status,
    response,
    url,
    state: url?.searchParams.get("state") ?? "",
    nonce: url?.searchParams.get("nonce") ?? "",
    /** `name=value`, as the browser would send it back. */
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
  };
}

type PagesAnswerInput = {
  nonce: string;
  config: SiopRpConfig;
  audience?: string;
  issuedAtSeconds?: number;
};

/** What Pages would sign for this login. */
export async function pagesAnswer(input: PagesAnswerInput) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  const idToken = await buildSelfIssuedIdToken({
    profile: { kind: "dynamic", issuer: issuerOf(input.config) },
    audience: input.audience ?? input.config.clientId,
    nonce: input.nonce,
    publicJwk,
    signingKey: privateKey,
    nowSeconds: input.issuedAtSeconds ?? Math.floor(Date.now() / 1000),
  });
  return { idToken, subject: await ecP256JwkThumbprint(publicJwk) };
}

/** What the callback page posts: the fragment, with the browser's cookie. */
export async function complete(
  base: string,
  path: string,
  response: string,
  cookie = "",
) {
  const answer = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ response }),
  });
  return { status: answer.status, body: await answer.json(), response: answer };
}

export const fragment = (idToken: string, state: string) =>
  `#${new URLSearchParams({ id_token: idToken, state }).toString()}`;
