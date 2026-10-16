/** Real static host with a socket refusal switch for cold installed-PWA verification. */
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

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
export async function startSecretBackendAppServer(dist, origin, base) {
  const root = path.resolve(dist);
  const controls = { offline: false, refusedRequests: 0 };
  const server = createServer((request, response) => {
    if (controls.offline) {
      controls.refusedRequests++;
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url, origin);
    const relative = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length)
      : url.pathname.slice(1);
    const candidate = path.resolve(root, relative);
    const isFile =
      candidate.startsWith(`${root}${path.sep}`) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile();
    if (!isFile && /\.[a-z0-9]+$/iu.test(relative)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing asset");
      return;
    }
    const file = isFile ? candidate : path.join(root, "index.html");
    response.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(new URL(origin).port, "127.0.0.1", resolve);
  });
  return {
    controls,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
