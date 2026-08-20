import { createHash, randomBytes } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import {
  assertDiscoveredUrl,
  assertDiscoveryBelongsToIssuer,
  assertSecureUrl,
  trimSlash,
} from "./secure-url.js";
import { overlapCast, isString } from "@opensesame/os-domain";

export interface LoopbackLoginConfig {
  issuer: string;
  clientId: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void> | void;
  signal?: AbortSignal;
  /** How long to hold the loopback port open waiting for the redirect. */
  timeoutMs?: number;
}

/** An abandoned login should not leave a port listening for the rest of the session. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoopbackTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}

/**
 * RFC 8252 loopback authorization code + PKCE.
 * Binds exclusively to 127.0.0.1 (never 0.0.0.0).
 */
export async function loopbackLogin(
  config: LoopbackLoginConfig,
): Promise<LoopbackTokens> {
  const issuer = assertSecureUrl(trimSlash(config.issuer), "issuer");
  const fetchImpl = config.fetchImpl ?? fetch;
  const discoveryRes = await fetchImpl(
    `${issuer}/.well-known/openid-configuration`,
  );
  if (!discoveryRes.ok)
    throw new Error(`discovery failed: ${discoveryRes.status}`);
  const meta = overlapCast(await discoveryRes.json());
  // This document says where the code and the verifier go. Take it only from the
  // issuer that names itself, and only over a channel nobody can rewrite.
  assertDiscoveryBelongsToIssuer(meta, issuer);
  assertDiscoveredUrl(
    meta.authorization_endpoint,
    "authorization_endpoint",
    issuer,
  );
  assertDiscoveredUrl(meta.token_endpoint, "token_endpoint", issuer);

  const { verifier, challenge, state } = pkce();
  const scopes = (config.scopes ?? ["openid", "profile"]).join(" ");

  return new Promise<LoopbackTokens>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    /** close() alone waits on keep-alive sockets the browser leaves open. */
    const shutdown = (): void => {
      if (timer) clearTimeout(timer);
      server.closeAllConnections?.();
      server.close();
    };
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          // Anything on this port that does not carry our state is not our redirect.
          // Answer it and keep waiting: letting a stray local request end the login
          // hands any process on the box a way to cancel it.
          const returnedState = url.searchParams.get("state");
          if (returnedState !== state) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("not this login");
            return;
          }
          const err = url.searchParams.get("error");
          if (err) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Authorization was refused. You can close this window.");
            shutdown();
            reject(new Error(err));
            return;
          }
          const code = url.searchParams.get("code");
          if (!code) {
            res.writeHead(400);
            res.end("invalid callback");
            shutdown();
            reject(new Error("invalid callback"));
            return;
          }
          const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            code_verifier: verifier,
          });
          const tokenRes = await fetchImpl(meta.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          });
          if (!tokenRes.ok) {
            res.writeHead(500);
            res.end("token exchange failed");
            shutdown();
            reject(new Error(`token exchange failed: ${tokenRes.status}`));
            return;
          }
          const tokens = overlapCast(await tokenRes.json());
          res.writeHead(200, { "content-type": "text/html" });
          res.end(
            "<html><body><h1>Signed in</h1><p>You can close this window.</p></body></html>",
          );
          shutdown();
          resolve(tokens);
        } catch (e) {
          shutdown();
          reject(e);
        }
      },
    );

    let redirectUri = "";
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || isString(addr)) {
        reject(new Error("failed to bind loopback"));
        return;
      }
      redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      const auth = new URL(meta.authorization_endpoint);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("client_id", config.clientId);
      auth.searchParams.set("redirect_uri", redirectUri);
      auth.searchParams.set("scope", scopes);
      auth.searchParams.set("state", state);
      auth.searchParams.set("code_challenge", challenge);
      auth.searchParams.set("code_challenge_method", "S256");
      void Promise.resolve(config.openBrowser?.(auth.toString())).catch(
        () => undefined,
      );
      timer = setTimeout(() => {
        shutdown();
        reject(new Error("timed out waiting for the authorization redirect"));
      }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
    });

    config.signal?.addEventListener("abort", () => {
      shutdown();
      reject(new Error("aborted"));
    });
  });
}
