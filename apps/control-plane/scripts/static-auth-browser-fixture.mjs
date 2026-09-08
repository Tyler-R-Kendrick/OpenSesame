import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { onFreePort } from "../src/__tests__/free-port.ts";
import { startServer } from "../src/server.ts";

/** Local, disposable fixtures only. No provider, production key, or external request. */
async function readArtifact() {
  const root = new URL("../../../", import.meta.url);
  const manifest = JSON.parse(
    await readFile(
      new URL("apps/pages/public/static-auth/manifest.json", root),
      "utf8",
    ),
  );
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const directory = new URL(
    `apps/pages/public/static-auth/${manifest.version}/`,
    root,
  );
  const bytes = await readFile(new URL("opensesame-auth.min.js", directory));
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  assert.equal(manifest.sri, sri, "Artifact manifest integrity");
  assert.equal(
    (
      await readFile(
        new URL("opensesame-auth.min.js.sha384", directory),
        "utf8",
      )
    ).trim(),
    sri,
  );
  return { manifest, bytes, sri };
}

export async function startFixture() {
  const { manifest, bytes, sri } = await readArtifact();
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "jwk" });
  const identity = await onFreePort((port) =>
    startServer({
      config: {
        host: "127.0.0.1",
        port,
        publicUrl: `http://127.0.0.1:${port}`,
        issuer: `http://127.0.0.1:${port}`,
      },
      processEnv: {
        OPENSESAME_ENV: "test",
        NODE_ENV: "test",
        OPENSESAME_CLAIM_PEPPER: randomBytes(32).toString("base64url"),
        OPENSESAME_OPERATOR_TOKEN: randomBytes(32).toString("base64url"),
        OPENSESAME_JWKS_JSON: JSON.stringify({
          keys: [
            { ...key, alg: "RS256", kid: "local-browser-oracle", use: "sig" },
          ],
        }),
        OPENSESAME_ORIGIN_CLIENTS_ENABLED: "true",
        LOG_LEVEL: "silent",
      },
    }),
  );
  const issuer = `http://127.0.0.1:${identity.port}`;
  const relyingParty = createServer((request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    if (request.url === "/sdk.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(bytes);
      return;
    }
    if (request.url === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const profile = {
      profile: "hosted_identity",
      issuer,
      clientId: `origin:${origin}`,
      redirectUri: `${origin}/opensesame/callback`,
      authorizationEndpoint: `${issuer}/auth`,
      tokenEndpoint: `${issuer}/token`,
      jwksUri: `${issuer}/jwks`,
    };
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Static sign-in verification</title>
      <h1>Static relying party</h1><button id="sign-in">Sign in</button><p role="status">Ready</p>
      <script src="/sdk.js" integrity="${sri}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
      <script>
      const profile = ${JSON.stringify(profile)};
      window.results = [];
      window.addEventListener("opensesame:signed_in", event => {
        window.results.push(event.detail);
        document.querySelector('[role="status"]').textContent = "Verified";
      });
      const fail = () => document.querySelector('[role="status"]').textContent = "Refused";
      document.querySelector('#sign-in').onclick = () => OpenSesame.signIn(profile).catch(fail);
      OpenSesame.complete(profile).catch(fail);
      </script></html>`);
  });
  await new Promise((resolve, reject) => {
    relyingParty.once("error", reject);
    relyingParty.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${relyingParty.address().port}`;
  return {
    origin,
    issuer,
    version: manifest.version,
    sri,
    async close() {
      await Promise.all(
        [identity.server, relyingParty].map(
          (server) =>
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    },
  };
}
