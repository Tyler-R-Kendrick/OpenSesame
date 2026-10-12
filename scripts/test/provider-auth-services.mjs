/** Real, checksum-pinned OpenBao and certified oidc-provider counterparties. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function boundPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function requestJson(url, { ca, token, body, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (token) headers["X-Vault-Token"] = token;
    if (bytes) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = bytes.length;
    }
    const request = https.request(
      url,
      {
        ca,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode,
            body: text ? JSON.parse(text) : null,
          });
        });
      },
    );
    request.setTimeout(10000, () =>
      request.destroy(new Error("Provider request timed out")),
    );
    request.on("error", reject);
    request.end(bytes);
  });
}

async function waitProviderHealthy(child, endpoint, tls) {
  let cert;
  let ca;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error("Real OpenBao exited during startup");
    const candidate = path.join(tls, "vault-cert.pem");
    if (fs.existsSync(candidate)) {
      cert = fs.readFileSync(candidate);
      ca = fs.readFileSync(path.join(tls, "vault-ca.pem"));
      try {
        const response = await requestJson(`${endpoint}/v1/sys/health`, { ca });
        if (response.status === 200) break;
      } catch (error) {
        if (attempt === 99) {
          throw error;
        }
      }
    }
    await pause(100);
  }
  assert.ok(cert, "OpenBao must create its development TLS certificate");
  const health = await requestJson(`${endpoint}/v1/sys/health`, { ca });
  assert.equal(health.status, 200);
  return { cert, ca };
}

async function stopProviderProcess(child, log) {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(deadline);
  }
  fs.closeSync(log);
}

export async function startOpenBao({
  root,
  out,
  providerBinary,
  providerName = "OpenBao 2.3.2",
}) {
  const binary =
    providerBinary ??
    execFileSync(
      "bash",
      [path.join(root, "scripts/mtls/mtls-fixtures.sh"), "path", "openbao"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENSESAME_MTLS_FIXTURE_DIR: path.join(out, "fixtures"),
        },
      },
    ).trim();
  const port = await boundPort();
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const tls = fs.mkdtempSync(path.join(out, "bao-tls-"));
  const rootToken = randomBytes(32).toString("base64url");
  const log = fs.openSync(path.join(out, "openbao-private.log"), "w", 0o600);
  const child = spawn(
    binary,
    [
      "server",
      "-dev",
      "-dev-tls",
      `-dev-listen-address=127.0.0.1:${port}`,
      `-dev-root-token-id=${rootToken}`,
      `-dev-tls-cert-dir=${tls}`,
    ],
    { stdio: ["ignore", log, log] },
  );
  const endpoint = `https://127.0.0.1:${port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await stopProviderProcess(child, log);
    fs.rmSync(tls, { recursive: true, force: true });
  };
  try {
    const { cert, ca } = await waitProviderHealthy(child, endpoint, tls);
    const certificate = new X509Certificate(cert);
    const spki = createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");
    async function api(
      route,
      body,
      method = body === undefined ? "GET" : "POST",
    ) {
      const response = await requestJson(`${endpoint}/v1/${route}`, {
        ca,
        token: rootToken,
        body,
        method,
      });
      assert.ok(
        response.status >= 200 && response.status < 300,
        `OpenBao setup ${method} ${route}: HTTP ${response.status}`,
      );
      return response.body;
    }
    return {
      name: providerName,
      endpoint,
      cert,
      ca,
      spki,
      tls,
      api,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function serveProviderInteraction({
  request,
  response,
  provider,
  password,
  observations,
  issuer,
  redirectUri,
  callback,
}) {
  if (request.url.startsWith("/untrusted-message")) {
    const query = new URL(request.url, issuer).searchParams;
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    const message = JSON.stringify({
      kind: "authorization-code",
      state: query.get("state"),
      code: "wrong-source-code",
      error: false,
      redirectUri,
      receipt: "a".repeat(64),
    }).replace(/</g, "\\u003c");
    response.end(
      `<!doctype html><body><script>(async()=>{const message=${message};const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(message.state));const name='opensesame.auth.'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');const channel=new BroadcastChannel(name);channel.postMessage(message);document.body.dataset.sent='true';setTimeout(()=>channel.close(),1000)})();</script>`,
    );
    return;
  }
  if (!request.url.startsWith("/interaction/"))
    return callback(request, response);
  try {
    const interaction = await provider.interactionDetails(request, response);
    if (request.method === "GET") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html><body><h1>Provider sign in</h1><form method="post"><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in to provider</button></form></body></html>',
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
      if (chunks.reduce((length, item) => length + item.length, 0) > 4096)
        throw new Error("Login body too large");
    }
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    if (
      body.get("username") !== "provider-user" ||
      body.get("password") !== password
    ) {
      response.writeHead(401).end("Invalid provider credentials");
      return;
    }
    const grant = new provider.Grant({
      accountId: "provider-auth-user",
      clientId: interaction.params.client_id,
    });
    grant.addOIDCScope("openid profile email");
    const grantId = await grant.save();
    observations.logins += 1;
    await provider.interactionFinished(
      request,
      response,
      { login: { accountId: "provider-auth-user" }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
  } catch {
    response.writeHead(500).end("Local provider interaction failed");
  }
}

export async function startProviderIssuer({ root, redirectUri, tls }) {
  const require = createRequire(
    path.join(root, "packages/oauth-provider/package.json"),
  );
  const { default: Provider } = await import(
    pathToFileURL(require.resolve("oidc-provider")).href
  );
  const port = await boundPort();
  const issuer = `https://127.0.0.1:${port}`;
  const clientId = "real-openbao-browser-auth";
  const clientSecret = randomBytes(32).toString("base64url");
  const password = randomBytes(24).toString("base64url");
  const observations = { authorizations: 0, tokens: 0, logins: 0 };
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
    ],
    features: { devInteractions: { enabled: false } },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    pkce: { required: () => true },
    claims: {
      openid: ["sub"],
      profile: ["name"],
      email: ["email", "email_verified"],
    },
    findAccount: async (_ctx, id) => ({
      accountId: id,
      claims: async () => ({
        sub: id,
        name: "Real local OIDC user",
        email: "provider-auth@example.test",
        email_verified: true,
      }),
    }),
  });
  provider.on("authorization.success", () => {
    observations.authorizations += 1;
  });
  provider.on("grant.success", () => {
    observations.tokens += 1;
  });
  const callback = provider.callback();
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(tls, "vault-key.pem")),
      cert: fs.readFileSync(path.join(tls, "vault-cert.pem")),
    },
    (request, response) =>
      serveProviderInteraction({
        request,
        response,
        provider,
        password,
        observations,
        issuer,
        redirectUri,
        callback,
      }),
  );
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    issuer,
    clientId,
    clientSecret,
    password,
    observations,
    ca: fs.readFileSync(path.join(tls, "vault-ca.pem")),
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function configureOpenBao(bao, idp, { origin, redirectUri }) {
  await bao.api("sys/auth/oidc", { type: "oidc" });
  await bao.api("auth/oidc/config", {
    oidc_discovery_url: idp.issuer,
    oidc_discovery_ca_pem: idp.ca.toString(),
    oidc_client_id: idp.clientId,
    oidc_client_secret: idp.clientSecret,
    default_role: "browser",
  });
  await bao.api("sys/policies/acl/browser-read", {
    policy: 'path "secret/data/browser-auth" { capabilities = ["read"] }',
  });
  await bao.api("auth/oidc/role/browser", {
    role_type: "oidc",
    bound_audiences: [idp.clientId],
    user_claim: "sub",
    allowed_redirect_uris: [redirectUri],
    oidc_scopes: ["profile", "email"],
    policies: ["browser-read"],
    ttl: "10m",
  });
  await bao.api("secret/data/browser-auth", {
    data: { message: "Authorized secret from real provider" },
  });
  await bao.api("sys/config/cors", {
    enabled: true,
    allowed_origins: [origin],
    allowed_headers: ["Content-Type", "X-Vault-Token", "X-Vault-Namespace"],
  });
}
