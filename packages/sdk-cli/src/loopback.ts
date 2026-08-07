import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export interface LoopbackLoginConfig {
  issuer: string;
  clientId: string;
  scopes?: string[];
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void> | void;
  signal?: AbortSignal;
}

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

function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * RFC 8252 loopback authorization code + PKCE.
 * Binds exclusively to 127.0.0.1 (never 0.0.0.0).
 */
export async function loopbackLogin(
  config: LoopbackLoginConfig,
): Promise<LoopbackTokens> {
  const issuer = trimSlash(config.issuer);
  const fetchImpl = config.fetchImpl ?? fetch;
  const discoveryRes = await fetchImpl(
    `${issuer}/.well-known/openid-configuration`,
  );
  if (!discoveryRes.ok) throw new Error(`discovery failed: ${discoveryRes.status}`);
  const meta = (await discoveryRes.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
  };

  const { verifier, challenge, state } = pkce();
  const scopes = (config.scopes ?? ["openid", "profile"]).join(" ");

  return new Promise<LoopbackTokens>((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const err = url.searchParams.get("error");
        if (err) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(`Authorization error: ${err}`);
          server.close();
          reject(new Error(err));
          return;
        }
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (!code || returnedState !== state) {
          res.writeHead(400);
          res.end("invalid callback");
          server.close();
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
          server.close();
          reject(new Error(`token exchange failed: ${tokenRes.status}`));
          return;
        }
        const tokens = (await tokenRes.json()) as LoopbackTokens;
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Signed in</h1><p>You can close this window.</p></body></html>");
        server.close();
        resolve(tokens);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    let redirectUri = "";
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
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
      void Promise.resolve(config.openBrowser?.(auth.toString())).catch(() => undefined);
    });

    config.signal?.addEventListener("abort", () => {
      server.close();
      reject(new Error("aborted"));
    });
  });
}
