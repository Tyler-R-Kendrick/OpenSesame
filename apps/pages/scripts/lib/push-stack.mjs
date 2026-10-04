/**
 * Everything `verify:push` and the Push-row evidence stand on, in one process:
 *
 *   - the Identity API, the real control-plane (`startServer()`) with in-memory
 *     repositories, a VAPID public key to serve and the Host's real Web Push
 *     worker wiring (`createWorkerNotificationAdapters`), whose transport is
 *   - the stand-in push service, which verifies each push's RFC 8292 VAPID
 *     token and decrypts its RFC 8291 body with libraries that share no code
 *     with the adapter, and
 *   - the Pages build (`dist-push-verify`, stamped `loopback_development` for
 *     the exact origin served here) over a real localhost socket.
 *
 * It imports TypeScript sources, so the script that uses it runs under `tsx`
 * (`pnpm --filter @opensesame/control-plane exec tsx …`, see the package
 * scripts). The origins are fixed because the Pages build stamps its own
 * origin: `loopback_development` is honoured only where the page's origin is
 * exactly the one the build was told (`resolveDeploymentProfile`).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PAGES_PORT = 41877;
export const API_PORT = 41878;
export const PAGES_ORIGIN = `http://localhost:${PAGES_PORT}`;
export const IDENTITY_API = `http://127.0.0.1:${API_PORT}`;

const repo = path.resolve(import.meta.dirname, "../../../..");
const source = (relative) => pathToFileURL(path.join(repo, relative)).href;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** A P-256 application server key pair, in the base64url form the Host reads. */
export function newVapid() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url").padEnd(43, "A"),
  };
}

/** `dist` under `base`, as a static host serves it, with this deployment's config. */
function serveDist({ dist, base, runtimeConfig }) {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const rel = pathname.startsWith(base)
      ? pathname.slice(base.length)
      : pathname.slice(1);
    if (rel === "os-runtime-config.json") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify(runtimeConfig()));
    }
    const file = path.join(dist, rel);
    if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
      response.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      return response.end(fs.readFileSync(file));
    }
    if (/\.[a-z0-9]+$/i.test(rel)) {
      response.writeHead(404);
      return response.end("not found");
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(fs.readFileSync(path.join(dist, "index.html")));
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(
          `port ${PAGES_PORT} is not free (${error.code ?? error.message}); the Pages build is stamped for exactly ${PAGES_ORIGIN}`,
        ),
      ),
    );
    server.listen(PAGES_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function json(api, route, bearer, init = {}) {
  const headers = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${api}${route}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * Ask `approver` to approve something, native push first, and run the Host's
 * delivery once: what the worker does on its interval.
 */
async function ring(
  { api, standIn, repos, adapters, runCleanupTick, requester },
  approver,
) {
  await json(api, "/v1/notification-preferences", approver.bearer, {
    method: "PUT",
    body: JSON.stringify({
      byClass: {
        authorization_request: {
          channels: ["native_push", "in_app"],
          fanOut: false,
        },
      },
    }),
  });
  const inbox = await json(
    api,
    "/v1/authorization-requests/inbox-ref",
    approver.bearer,
  );
  const created = await json(
    api,
    "/v1/authorization-requests",
    requester.bearer,
    {
      method: "POST",
      headers: { "idempotency-key": `verify-push-${Date.now()}` },
      body: JSON.stringify({
        approverRef: inbox.body.approverRef,
        authorizationDetails: [{ type: "secret_use", actions: ["read"] }],
        bindingMessage: "verify:push",
      }),
    },
  );
  if (created.status !== 201)
    throw new Error(`authorization request: ${created.status}`);
  const waiting = standIn.next(10_000);
  const tick = await runCleanupTick({
    repos,
    clock: () => new Date(),
    notificationAdapters: adapters,
  });
  return { requestId: created.body.authReqId, tick, push: await waiting };
}

/**
 * Start the stack. `runtimeConfig` is what the deployment's
 * `os-runtime-config.json` says; `identityApi` is always this stack's.
 */
export async function startPushStack({
  dist,
  base,
  runtimeConfig = () => ({}),
}) {
  const vapid = newVapid();
  Object.assign(process.env, {
    OPENSESAME_ENV: "development",
    OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
    OPENSESAME_WEBPUSH_PUBLIC_KEY: vapid.publicKey,
    OPENSESAME_WEBPUSH_PRIVATE_KEY: vapid.privateKey,
    OPENSESAME_WEBPUSH_SUBJECT: "mailto:ops@example.test",
    OPENSESAME_CORS_ORIGINS: PAGES_ORIGIN,
    OPENSESAME_CONTROL_PLANE_PORT: String(API_PORT),
  });
  // Not `= undefined`: that would store the string "undefined".
  Reflect.deleteProperty(process.env, "DATABASE_URL");
  const { startServer } = await import(
    source("packages/control-plane/src/server.ts")
  );
  const { startPushStandIn } = await import(
    source("packages/notification-adapters/test-support/index.ts")
  );
  const { createWorkerNotificationAdapters } = await import(
    source("packages/identity-worker/src/web-push-channel.ts")
  );
  const { runCleanupTick } = await import(
    source("packages/identity-worker/src/cleanup.ts")
  );
  const started = await startServer();
  const standIn = await startPushStandIn({ vapidPublicKey: vapid.publicKey });
  const adapters = createWorkerNotificationAdapters({
    repos: started.ctx.repos,
    env: process.env,
    fetchImpl: standIn.fetchImpl,
  });
  const pages = await serveDist({
    dist,
    base,
    runtimeConfig: () => ({ identityApi: IDENTITY_API, ...runtimeConfig() }),
  });

  const api = `http://127.0.0.1:${started.port}`;
  const stack = {
    api,
    origin: PAGES_ORIGIN,
    vapid,
    standIn,
    repos: started.ctx.repos,
    /** A second principal, the way a person gets one: an anonymous session. */
    async principal() {
      const made = await json(api, "/v1/principals/provisional", "", {
        method: "POST",
        body: "{}",
      });
      return { bearer: made.body.accessToken, id: made.body.principalId };
    },
    /** Who a session bearer is, as the Identity API says. */
    async whoIs(bearer) {
      const me = await json(api, "/v1/principals/me", bearer);
      if (me.status !== 200) throw new Error(`/v1/principals/me: ${me.status}`);
      return me.body.id;
    },
    /** The live subscriptions a principal holds on the Identity API. */
    async live(principalId) {
      const held =
        await started.ctx.repos.pushSubscriptions.listForPrincipal(principalId);
      return held.filter((sub) => !sub.disabledAt);
    },
    register: (bearer, sub) =>
      json(api, "/v1/notification-channels/push/subscriptions", bearer, {
        method: "POST",
        body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
      }),
    ring: async (approver) =>
      ring(
        {
          api,
          standIn,
          repos: started.ctx.repos,
          adapters,
          runCleanupTick,
          requester: await stack.principal(),
        },
        approver,
      ),
    async close() {
      await new Promise((resolve) => pages.close(resolve));
      await standIn.close();
      await new Promise((resolve) => started.server.close(resolve));
    },
  };
  return stack;
}
