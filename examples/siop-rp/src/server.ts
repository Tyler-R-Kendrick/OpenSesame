import { randomBytes } from "node:crypto";
/**
 * Minimal SIOPv2 relying party — nonce/state on the server, verify via @opensesame/siop-v2.
 */
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { buildSiopAuthorizationUrl } from "./auth-request.js";
import { siopCallbackHtml } from "./callback-page.js";
import { loadSiopRpConfig } from "./config.js";
import { NonceStore } from "./nonce-store.js";
import { verifySiopCallback } from "./verify-callback.js";

const config = loadSiopRpConfig();
const store = new NonceStore();

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

type ExampleRpErrorResponse = {
  error: string;
};

type ExampleRpSessionResponse = {
  session: {
    subject: string;
    issuer: string;
    audience: string;
    nonce: string;
    iAmSiop: boolean;
  };
};

type ExampleRpJsonBody = ExampleRpErrorResponse | ExampleRpSessionResponse;

type CompleteCallbackBody = {
  id_token?: string;
  state?: string;
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: ExampleRpJsonBody,
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<CompleteCallbackBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0 || raw.length > 16_384) return {};
  try {
    const parsed = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed)) return {};
    const out: CompleteCallbackBody = {};
    if ("id_token" in parsed && isString(parsed.id_token)) {
      out.id_token = parsed.id_token;
    }
    if ("state" in parsed && isString(parsed.state)) {
      out.state = parsed.state;
    }
    return out;
  } catch {
    return {};
  }
}

function indexHtml(): string {
  const start = "/auth/start";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenSesame SIOP example RP</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 42rem; line-height: 1.5; }
    code { font-size: 0.9em; }
    .note { color: #444; font-size: 0.95rem; }
  </style>
</head>
<body>
  <h1>SIOPv2 example relying party</h1>
  <p class="note">Implementer's Draft 1 — self-issued authentication only. Email and other optional claims are <strong>self-asserted</strong>, not verified identity.</p>
  <p><a href="${start}">Sign in with OpenSesame Pages (Self-Issued OP)</a></p>
  <p class="note">Pages base: <code>${config.pagesBase}</code><br />
  client_id: <code>${config.clientId}</code><br />
  redirect_uri: <code>${config.redirectUri}</code></p>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? config.listen}`,
  );

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/start") {
    const nonce = randomUrlSafe(32);
    const state = randomUrlSafe(24);
    store.issue(state, nonce, Date.now());
    const target = buildSiopAuthorizationUrl(config, { nonce, state });
    res.writeHead(302, { location: target });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/callback") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(siopCallbackHtml());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/complete") {
    const body = await readJsonBody(req);
    if (!body.id_token || !body.state) {
      const errorResponse: ExampleRpErrorResponse = {
        error: "id_token and state are required",
      };
      sendJson(res, 400, errorResponse);
      return;
    }
    try {
      const { verified } = await verifySiopCallback({
        idToken: body.id_token,
        state: body.state,
        config,
        store,
      });
      const sessionResponse: ExampleRpSessionResponse = {
        session: {
          subject: verified.sub,
          issuer: verified.iss,
          audience: verified.aud,
          nonce: verified.nonce,
          iAmSiop: verified.iAmSiop,
        },
      };
      sendJson(res, 200, sessionResponse);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Verification failed";
      const errorResponse: ExampleRpErrorResponse = { error: message };
      sendJson(res, 401, errorResponse);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(config.port, config.host, () => {
  console.log(`SIOP example RP listening on http://${config.listen}`);
});
