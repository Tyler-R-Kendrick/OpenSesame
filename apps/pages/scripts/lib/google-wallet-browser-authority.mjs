/** Independent actual TLS authority for the finite Google contract; no application state is imported. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
import {
  GOOGLE_WALLET_CLASS,
  GOOGLE_WALLET_CLASS_URL,
  GOOGLE_WALLET_SAVE_PREFIX,
  GOOGLE_WALLET_TOKEN_URL,
  createGoogleWalletProtocol,
} from "./google-wallet-browser-protocol.mjs";
import {
  googleWalletBrowserArguments,
  googleWalletCertificate,
} from "./google-wallet-browser-tls.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function boundedBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    assert.ok(bytes <= 32768, "Bounded service-account form");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
class GoogleWalletAuthority {
  #next = new Map();
  #holds = new Map();
  #live = new Set();
  constructor(origin, denyClassCors) {
    this.origin = new URL(origin).origin;
    this.denyClassCors = denyClassCors;
    this.protocol = createGoogleWalletProtocol(this.origin);
    this.tls = googleWalletCertificate();
    this.rows = [];
    this.unexpected = [];
    this.errors = [];
    this.server = createServer(
      { ...this.tls, minVersion: "TLSv1.2" },
      (request, response) => {
        this.serve(request, response).catch(() => {
          this.errors.push("Unclassified authority handler failure");
          response.destroy();
        });
      },
    );
  }
  async start() {
    await once(this.server.listen(0, "127.0.0.1"), "listening");
    const address = this.server.address();
    assert.ok(address && Number.isSafeInteger(address.port));
    this.port = address.port;
    this.browserArgs = googleWalletBrowserArguments(this.port, this.tls.spki);
    return this;
  }
  get account() {
    return this.protocol.account;
  }
  snapshot() {
    return {
      ...this.protocol.snapshot(),
      rows: this.rows.map((row) => ({ ...row })),
      errors: [...this.errors],
      unexpected: [...this.unexpected],
    };
  }
  faultNext(stage, mode) {
    assert.ok(["token", "class"].includes(stage));
    assert.ok(
      ["deny", "bad-token", "malformed", "wrong-class", "oversize"].includes(
        mode,
      ),
    );
    assert.ok(!this.#next.has(stage));
    this.#next.set(stage, mode);
  }
  holdNext(stage) {
    assert.ok(["token", "class"].includes(stage));
    assert.ok(!this.#holds.has(stage));
    const hold = {
      arrived: deferred(),
      closed: deferred(),
      released: deferred(),
    };
    this.#holds.set(stage, hold);
    this.#live.add(hold);
    return {
      arrived: hold.arrived.promise,
      closed: hold.closed.promise,
      release: () => hold.released.resolve(),
    };
  }
  cors(request, response, stage) {
    assert.equal(
      request.headers.origin,
      this.origin,
      "Exact application Origin",
    );
    if (stage === "class" && this.denyClassCors) return;
    response.setHeader("access-control-allow-origin", this.origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader(
      "access-control-allow-headers",
      "authorization,content-type",
    );
    response.setHeader("access-control-max-age", "0");
    if (request.headers["access-control-request-private-network"] === "true")
      response.setHeader("access-control-allow-private-network", "true");
    if (request.method === "OPTIONS") {
      assert.equal(
        request.headers["access-control-request-method"],
        stage === "token" ? "POST" : "GET",
      );
      const headers = String(
        request.headers["access-control-request-headers"] ?? "",
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      assert.ok(
        headers.every((value) =>
          ["authorization", "content-type"].includes(value),
        ),
      );
    }
  }
  classify(request) {
    assert.equal(request.socket.encrypted, true, "A genuine TLS socket");
    const url = new URL(request.url, `https://${request.headers.host}`);
    if (url.href === GOOGLE_WALLET_TOKEN_URL) return { stage: "token", url };
    if (url.href === GOOGLE_WALLET_CLASS_URL) return { stage: "class", url };
    if (url.href.startsWith(GOOGLE_WALLET_SAVE_PREFIX) && !url.search)
      return { stage: "save", url };
    throw new Error("Unowned authority path");
  }
  async serve(request, response) {
    let target;
    try {
      target = this.classify(request);
    } catch {
      this.unexpected.push(`${request.method} unowned Google fixture path`);
      response.writeHead(404);
      response.end();
      return;
    }
    const { stage, url } = target;
    const row = {
      stage,
      method: request.method,
      path: stage === "save" ? "/gp/v/save/[jwt]" : url.pathname,
      tlsServername: request.socket.servername,
      preflight: request.method === "OPTIONS",
      authorized: false,
      status: null,
      expected: false,
      completed: false,
      cancelled: false,
    };
    this.rows.push(row);
    try {
      assert.equal(
        request.socket.servername,
        url.hostname,
        "Original Google TLS hostname",
      );
      assert.equal(
        request.headers.cookie,
        undefined,
        "No ambient cookie authority",
      );
      if (stage === "save") return this.save(request, response, url, row);
      this.cors(request, response, stage);
      if (request.method === "OPTIONS") {
        row.status = 204;
        row.completed = true;
        response.writeHead(204);
        response.end();
        return;
      }
      const body = await this.api(request, stage);
      row.authorized = true;
      await this.reply(response, row, body);
    } catch {
      row.status = 401;
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"protocol_refused"}');
    }
  }
  async api(request, stage) {
    if (stage === "token") {
      assert.equal(request.method, "POST");
      assert.ok(
        String(request.headers["content-type"]).startsWith(
          "application/x-www-form-urlencoded",
        ),
      );
      assert.equal(request.headers.authorization, undefined);
      return this.protocol.issue(await boundedBody(request));
    }
    assert.equal(request.method, "GET");
    this.protocol.authorize(request.headers.authorization);
    assert.equal(await boundedBody(request), "");
    return { id: GOOGLE_WALLET_CLASS };
  }
  async reply(response, row, body) {
    const fault = this.#next.get(row.stage);
    this.#next.delete(row.stage);
    row.expected = fault === "deny";
    row.status = fault === "deny" ? 403 : 200;
    const payload =
      fault === "deny"
        ? { error: "fixture_permission_denied" }
        : fault === "bad-token"
          ? { access_token: "short", expires_in: 3600 }
          : fault === "wrong-class"
            ? { id: `${GOOGLE_WALLET_CLASS}.foreign` }
            : fault === "oversize"
              ? { ...body, padding: "x".repeat(65536) }
              : body;
    const wire =
      fault === "malformed" ? "invalid-json" : JSON.stringify(payload);
    response.writeHead(row.status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(wire),
    });
    const hold = this.#holds.get(row.stage);
    this.#holds.delete(row.stage);
    if (hold) {
      response.once("close", () => {
        row.cancelled = !response.writableEnded;
        if (row.cancelled) hold.closed.resolve();
      });
      response.flushHeaders();
      response.write(wire.slice(0, 5));
      hold.arrived.resolve();
      await hold.released.promise;
      this.#live.delete(hold);
      if (response.destroyed) return;
      response.end(wire.slice(5));
    } else response.end(wire);
    row.completed = true;
  }
  save(request, response, url, row) {
    assert.equal(request.method, "GET");
    this.protocol.save(url.href);
    row.authorized = true;
    row.status = 200;
    row.completed = true;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Google Wallet protocol save accepted</h1><p>Controlled fixture only; no real pass was installed.</p></body></html>',
    );
  }
  async close() {
    for (const hold of this.#live) hold.released.resolve();
    this.server.closeAllConnections();
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
export async function startGoogleWalletBrowserAuthority({
  origin,
  denyClassCors = false,
}) {
  return new GoogleWalletAuthority(origin, denyClassCors).start();
}
