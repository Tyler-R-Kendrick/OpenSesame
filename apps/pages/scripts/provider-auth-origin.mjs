/** Session-free static HTTPS origin: callback routing cannot know an opener. */
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

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

export async function startProviderAuthOrigin({
  dist,
  tls,
  base,
  port = 0,
  hostname = "localhost",
}) {
  assert.ok(
    fs.existsSync(path.join(dist, "index.html")),
    "Build production Pages first",
  );
  const observations = { returns: [], requests: 0 };
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(tls, "vault-key.pem")),
      cert: fs.readFileSync(path.join(tls, "vault-cert.pem")),
    },
    (request, response) => {
      const url = new URL(request.url, "https://localhost");
      observations.requests += 1;
      if (url.searchParams.has("code") || url.searchParams.has("state"))
        observations.returns.push({
          pathname: url.pathname,
          keys: [...url.searchParams.keys()],
        });
      // Deliberately no sessions, cookies, OAuth exchange, originator lookup or proxy.
      const relative = url.pathname.startsWith(base)
        ? url.pathname.slice(base.length)
        : "";
      const file = path.resolve(dist, relative || "index.html");
      if (!file.startsWith(`${path.resolve(dist)}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const exists = fs.existsSync(file) && fs.statSync(file).isFile();
      const target = exists ? file : path.join(dist, "index.html");
      response.writeHead(exists ? 200 : 404, {
        "Content-Type":
          MIME[path.extname(target)] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(target).pipe(response);
    },
  );
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `https://${hostname}:${server.address().port}`;
  return {
    origin,
    observations,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
