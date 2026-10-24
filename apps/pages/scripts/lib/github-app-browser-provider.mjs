/** Independent HTTP provider fixture. Browser routing qualifies the request boundary, not GitHub TLS. */
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  GithubBrowserRepositories,
  OWNER,
  canonical,
  digest,
  opaque,
  requireValue,
} from "./github-app-browser-repositories.mjs";
const PERMISSIONS = {
  metadata: "read",
  contents: "write",
  administration: "write",
  workflows: "write",
  pull_requests: "write",
};
function form(title, action, button) {
  return `<!doctype html><html><head><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1><p>Independent GitHub protocol fixture; no real GitHub account is used.</p><form method="post" action="${action}"><button type="submit">${button}</button></form></body></html>`;
}
class GithubBrowserProvider extends GithubBrowserRepositories {
  apps = new Map();
  codes = new Map();
  tokens = new Map();
  nextApp = 4100;
  jwtChecks = 0;
  conversions = 0;
  constructor({ appOrigin, base }) {
    super();
    this.appOrigin = new URL(appOrigin).origin;
    this.base = base;
  }
  register(body, url) {
    requireValue(this.apps.size < 8, 429, "Fixture registration limit");
    const state = url.searchParams.get("state") ?? "";
    requireValue(/^[a-f0-9]{32}$/.test(state), 400, "Invalid manifest state");
    const manifest = JSON.parse(
      new URLSearchParams(body).get("manifest") ?? "null",
    );
    requireValue(
      manifest && manifest.public === false,
      400,
      "Invalid private manifest",
    );
    requireValue(
      String(manifest.name) === manifest.name &&
        manifest.name.length > 0 &&
        manifest.name.length <= 32,
      400,
      "Invalid manifest name",
    );
    const callback = new URL(manifest.redirect_url);
    requireValue(
      callback.origin === this.appOrigin &&
        callback.pathname.startsWith(this.base),
      400,
      "Wrong manifest callback",
    );
    requireValue(
      callback.searchParams.get("github_app") === "claim" && !callback.hash,
      400,
      "Missing static claim marker",
    );
    requireValue(
      JSON.stringify(manifest.callback_urls) ===
        JSON.stringify([callback.href]),
      400,
      "Wrong OAuth callback",
    );
    requireValue(
      canonical(manifest.default_permissions) === canonical(PERMISSIONS),
      400,
      "Wrong manifest permissions",
    );
    const setup = new URL(manifest.setup_url);
    requireValue(
      setup.origin === callback.origin &&
        setup.pathname === callback.pathname &&
        setup.searchParams.get("github_app") === "installed",
      400,
      "Wrong setup return",
    );
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const id = this.nextApp++;
    const app = {
      id,
      slug: `browser-app-${id}`,
      name: manifest.name,
      state,
      callback: callback.href,
      setup: setup.href,
      keys,
      pem: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      clientSecret: opaque(),
      installed: false,
      installationId: id + 1000,
      approved: false,
    };
    this.apps.set(String(id), app);
    return {
      status: 200,
      html: form(
        "Register fixture GitHub App",
        `/fixture/register/${id}`,
        "Register fixture GitHub App",
      ),
    };
  }
  appValue(app) {
    return {
      id: app.id,
      slug: app.slug,
      name: app.name,
      client_id: `Iv1.browser-${app.id}`,
      owner: { login: OWNER, type: "User" },
      html_url: `https://github.com/apps/${app.slug}`,
    };
  }
  installation(app) {
    return {
      id: app.installationId,
      account: { login: OWNER, type: "User" },
      repository_selection: "all",
    };
  }
  site(body, method, url) {
    if (url.pathname === "/settings/apps/new" && method === "POST")
      return this.register(body, url);
    const register = /^\/fixture\/register\/(\d+)$/.exec(url.pathname);
    if (register && method === "POST") {
      const app = this.apps.get(register[1]);
      requireValue(app && !app.approved, 400, "Registration already consumed");
      app.approved = true;
      const code = opaque();
      this.codes.set(code, app);
      const destination = new URL(app.callback);
      destination.searchParams.set("code", code);
      destination.searchParams.set("state", app.state);
      return { status: 302, location: destination.href };
    }
    const install = /^\/apps\/([a-z0-9-]+)\/installations\/new$/.exec(
      url.pathname,
    );
    if (install && method === "GET") {
      const app = [...this.apps.values()].find(
        (row) => row.slug === install[1],
      );
      requireValue(app?.approved, 404, "Unknown app installation");
      return {
        status: 200,
        html: form(
          "Install fixture GitHub App",
          `/fixture/install/${app.id}`,
          "Install fixture GitHub App",
        ),
      };
    }
    const confirmation = /^\/fixture\/install\/(\d+)$/.exec(url.pathname);
    if (confirmation && method === "POST") {
      const app = this.apps.get(confirmation[1]);
      requireValue(app?.approved, 404, "Unknown app installation");
      app.installed = true;
      const destination = new URL(app.setup);
      destination.searchParams.set(
        "installation_id",
        String(app.installationId),
      );
      return { status: 302, location: destination.href };
    }
    throw Object.assign(new Error("Unexpected GitHub website request"), {
      status: 404,
    });
  }
  jwt(authorization) {
    try {
      requireValue(
        String(authorization).startsWith("Bearer "),
        401,
        "Missing App bearer assertion",
      );
      const pieces = String(authorization)
        .replace(/^Bearer /, "")
        .split(".");
      const header = JSON.parse(
        Buffer.from(pieces[0] ?? "", "base64url").toString(),
      );
      const claims = JSON.parse(
        Buffer.from(pieces[1] ?? "", "base64url").toString(),
      );
      const app = this.apps.get(String(claims.iss));
      const now = Math.floor(Date.now() / 1000);
      requireValue(
        app?.approved &&
          pieces.length === 3 &&
          header.alg === "RS256" &&
          header.typ === "JWT",
        401,
        "Invalid App assertion",
      );
      requireValue(
        Number.isSafeInteger(claims.iat) &&
          Number.isSafeInteger(claims.exp) &&
          claims.iat <= now + 60 &&
          claims.exp > now &&
          claims.exp - claims.iat <= 600,
        401,
        "Expired App assertion",
      );
      requireValue(
        verify(
          "RSA-SHA256",
          Buffer.from(`${pieces[0]}.${pieces[1]}`),
          app.keys.publicKey,
          Buffer.from(pieces[2], "base64url"),
        ),
        401,
        "Bad App assertion signature",
      );
      this.jwtChecks++;
      return app;
    } catch {
      throw Object.assign(new Error("App authentication refused"), {
        status: 401,
      });
    }
  }
  async boundary(request, raw, response, row) {
    const input = new URL(request.url, "http://fixture.invalid");
    const lane = input.pathname.startsWith("/api/")
      ? "api"
      : input.pathname.startsWith("/site/")
        ? "site"
        : null;
    requireValue(lane, 404, "Unknown request boundary");
    const url = new URL(
      `${input.pathname.slice(lane.length + 1)}${input.search}`,
      lane === "api" ? "https://api.github.com" : "https://github.com",
    );
    row.path = `${lane}:${url.pathname.replace(/\/app-manifests\/[^/]+\//, "/app-manifests/[code]/")}`;
    if (lane === "api") {
      requireValue(
        request.headers.cookie === undefined,
        400,
        "API cookie refused",
      );
      requireValue(
        request.headers["x-github-api-version"] === "2022-11-28",
        400,
        "Wrong GitHub API version",
      );
    }
    return lane === "api"
      ? await this.api(request.method, url, request.headers, raw, response)
      : this.site(raw, request.method, url);
  }
  async handle(request, response) {
    let raw = "";
    request.setEncoding("utf8");
    const row = {
      method: request.method,
      path: "",
      status: 0,
      bodyBytes: 0,
      bodySha256: "",
      closed: false,
    };
    response.once("close", () => {
      row.closed = true;
    });
    try {
      requireValue(this.rows.length < 5000, 429, "Fixture request limit");
      this.rows.push(row);
      for await (const chunk of request) {
        raw += chunk;
        requireValue(
          Buffer.byteLength(raw) <= 1048576,
          413,
          "Provider request too large",
        );
      }
      row.bodyBytes = Buffer.byteLength(raw);
      row.bodySha256 = digest(raw);
      if (request.method === "OPTIONS") {
        row.status = 204;
        response
          .writeHead(204, {
            "Access-Control-Allow-Origin": this.appOrigin,
            "Access-Control-Allow-Headers":
              "authorization,content-type,x-github-api-version",
            "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
          })
          .end();
        return;
      }
      const result = await this.boundary(request, raw, response, row);
      if (!result || response.destroyed) return;
      row.status = result.status;
      const headers = {
        "Content-Type": result.html
          ? "text/html; charset=utf-8"
          : "application/json",
        "Access-Control-Allow-Origin": this.appOrigin,
        "Access-Control-Allow-Headers":
          "authorization,content-type,x-github-api-version",
        "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
        "Cache-Control": "no-store",
      };
      if (result.location) headers.Location = result.location;
      response.writeHead(result.status, headers);
      response.end(result.html ?? JSON.stringify(result.value));
    } catch (error) {
      row.status = Number.isInteger(error.status) ? error.status : 500;
      if (row.status === 500)
        this.errors.push("Unexpected provider fixture failure");
      if (!response.destroyed)
        response
          .writeHead(row.status, { "Content-Type": "application/json" })
          .end('{"message":"Provider request refused"}');
    }
  }
  assertNoSecret(text) {
    for (const app of this.apps.values())
      for (const secret of [app.pem, app.clientSecret])
        assert.ok(
          !text.includes(secret),
          "Fixture App secret escaped its approved boundary",
        );
    for (const token of this.tokens.keys())
      assert.ok(
        !text.includes(token),
        "Installation token escaped its approved boundary",
      );
  }
}

export async function startGithubBrowserProvider(options) {
  const provider = new GithubBrowserProvider(options);
  const server = createServer((request, response) => {
    void provider.handle(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address()?.port;
  assert.ok(
    Number.isInteger(port) && port > 0 && port <= 65535,
    "Expected provider TCP listener",
  );
  return {
    endpoint: `http://127.0.0.1:${port}`,
    rows: provider.rows,
    snapshot: (name) => provider.snapshot(name),
    ciphertext(name, commit) {
      const repo = provider.repos.get(name);
      const bytes = commit ? repo?.commits.get(commit) : repo?.bytes;
      assert.ok(bytes, "Expected stored encrypted provider content");
      return bytes.toString("utf8");
    },
    holdNextRead: () => provider.holdNextRead(),
    assertNoSecret: (text) => provider.assertNoSecret(text),
    assertCiphertextExcludes(name, values) {
      const bytes = provider.repos.get(name)?.bytes;
      assert.ok(bytes, "Expected provider ciphertext before secrecy assertion");
      const text = bytes.toString("utf8");
      provider.assertNoSecret(text);
      for (const value of values)
        assert.ok(!text.includes(value), "Vault plaintext escaped encryption");
    },
    assertClean: () => assert.deepEqual(provider.errors, []),
    summary: () => provider.summary(),
    async close() {
      for (const held of provider.holds) held.gate.resolve();
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
