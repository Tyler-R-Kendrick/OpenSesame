/** Real TLS provider transport and immutable compiled-file service. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { googleWalletCertificate } from "./google-wallet-browser-tls.mjs";
import {
  BASE,
  IDP,
  PWA,
  PublicOidcProtocol,
} from "./public-oidc-browser-protocol.mjs";
export { BASE, IDP, PWA } from "./public-oidc-browser-protocol.mjs";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
function html(value) {
  const escapes = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value).replace(/[&<>"']/g, (part) => escapes[part]);
}
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    assert.ok(size <= 32768);
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export class PublicOidcAuthority {
  constructor(dist) {
    this.dist = fs.realpathSync(dist);
    this.tls = googleWalletCertificate([
      new URL(PWA).hostname,
      new URL(IDP).hostname,
    ]);
    this.protocol = new PublicOidcProtocol();
    this.rows = [];
    this.errors = [];
    this.server = createServer(this.tls, (request, response) => {
      const url = new URL(request.url, `https://${request.headers.host}`);
      const row = {
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        tls: request.socket.encrypted === true,
        sni: request.socket.servername,
        status: null,
        cors: false,
        completed: false,
      };
      this.rows.push(row);
      response.once("finish", () => {
        row.completed = true;
      });
      void this.serve(request, response, url, row).catch((error) => {
        this.errors.push({
          name: error.name,
          message: "Independent TLS provider/static contract refused",
        });
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  }
  async start() {
    await once(this.server.listen(0, "127.0.0.1"), "listening");
    const port = this.server.address()?.port;
    assert.ok(
      Number.isSafeInteger(port) && port >= 1 && port <= 65535,
      "Expected the bound TCP port",
    );
    this.port = port;
    this.browserArgs = [
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${new URL(PWA).hostname} 127.0.0.1:${this.port}, MAP ${new URL(IDP).hostname} 127.0.0.1:${this.port}`,
      `--ignore-certificate-errors-spki-list=${this.tls.spki}`,
    ];
    return this;
  }
  add(id) {
    return this.protocol.add(id);
  }
  fault(id, mode) {
    this.protocol.fault(id, mode);
  }
  stats(id) {
    return {
      ...this.protocol.stats(id),
      rows: this.rows
        .filter((row) => row.path.startsWith(`/case/${id}/`))
        .map((row) => ({ ...row })),
    };
  }
  reply(response, row, status, payload, headers = {}) {
    row.status = status;
    response.writeHead(status, { "cache-control": "no-store", ...headers });
    response.end(payload);
  }
  cors(request, response, row, value) {
    assert.equal(request.headers.origin, PWA);
    assert.equal(request.headers.cookie, undefined);
    if (value.mode !== "cors" || !row.path.endsWith("/token")) {
      row.cors = true;
      response.setHeader("access-control-allow-origin", PWA);
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("access-control-max-age", "0");
    }
  }
  async consent(request, response, url, row, value) {
    assert.ok(["GET", "POST"].includes(request.method));
    const fields =
      request.method === "GET"
        ? url.searchParams
        : new URLSearchParams(await body(request));
    this.protocol.authorize(fields, value);
    if (request.method === "GET") {
      const inputs = [...fields]
        .map(
          ([name, item]) =>
            `<input type="hidden" name="${html(name)}" value="${html(item)}">`,
        )
        .join("");
      return this.reply(
        response,
        row,
        200,
        `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><h1>Independent OIDC provider</h1><form method="post" action="${html(url.pathname)}">${inputs}<button>Approve test sign-in</button></form></body></html>`,
        { "content-type": "text/html" },
      );
    }
    return this.reply(response, row, 302, "", {
      location: this.protocol.consent(fields, value),
    });
  }
  async serve(request, response, url, row) {
    assert.equal(row.tls, true);
    assert.equal(row.sni, url.hostname);
    if (
      url.origin === PWA &&
      url.pathname === "/favicon.ico" &&
      !url.search &&
      request.method === "GET"
    )
      return this.reply(response, row, 404, "", {
        "content-type": "image/x-icon",
      });
    if (url.origin === PWA) return this.static(response, url, row);
    assert.equal(url.origin, IDP);
    const match = /^\/case\/([a-z0-9-]+)\/(authorize|token|jwks)$/.exec(
      url.pathname,
    );
    assert.ok(match, "Only declared IdP paths are served");
    const value = this.protocol.get(match[1]);
    const stage = match[2];
    if (stage === "authorize")
      return this.consent(request, response, url, row, value);
    this.cors(request, response, row, value);
    if (request.method === "OPTIONS") return this.reply(response, row, 204, "");
    if (stage === "jwks") {
      assert.equal(request.method, "GET");
      return this.reply(
        response,
        row,
        200,
        JSON.stringify(this.protocol.jwks()),
        { "content-type": "application/json" },
      );
    }
    assert.equal(request.method, "POST");
    assert.match(
      request.headers["content-type"] ?? "",
      /^application\/x-www-form-urlencoded/,
    );
    assert.equal(request.headers.authorization, undefined);
    const fields = new URLSearchParams(await body(request));
    return this.reply(
      response,
      row,
      200,
      JSON.stringify(this.protocol.token(fields, value)),
      { "content-type": "application/json" },
    );
  }
  static(response, url, row) {
    assert.ok(url.pathname.startsWith(BASE));
    const relative = decodeURIComponent(url.pathname.slice(BASE.length));
    const candidate = path.resolve(this.dist, relative || "index.html");
    assert.ok(candidate.startsWith(`${this.dist}${path.sep}`));
    const exists = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    if (!exists && /\.[a-z0-9]+$/i.test(relative))
      return this.reply(response, row, 404, "Missing compiled asset");
    const file = exists ? candidate : path.join(this.dist, "index.html");
    assert.equal(fs.realpathSync(file), file);
    return this.reply(response, row, 200, fs.readFileSync(file), {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
