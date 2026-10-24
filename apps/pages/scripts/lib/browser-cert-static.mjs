import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

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
function inside(root, candidate) {
  const rest = relative(root, candidate);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
/** Index regular build outputs once so requests only select allowlisted files. */
function staticFiles(dist) {
  const root = realpathSync(dist);
  const files = new Map();
  const blocked = new Set();
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const urlPath = `${prefix}/${entry.name}`;
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        if (entry.isSymbolicLink()) blocked.add(urlPath);
        else walk(file, urlPath);
        continue;
      }
      if (!entry.isFile()) {
        blocked.add(urlPath);
        continue;
      }
      const real = realpathSync(file);
      if (inside(root, real)) files.set(urlPath, real);
      else blocked.add(urlPath);
    }
  };
  walk(root, "");
  return { files, blocked };
}

export function browserCertStaticHandler(dist) {
  const { files, blocked } = staticFiles(dist);
  const index = files.get("/index.html");
  if (!index) throw new Error("Static build lacks index.html");
  return (req, res) => {
    const send = (body, type) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    try {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (path === "/__cors-probe")
        return send("<!doctype html><title>cors probe</title>", "text/html");
      const rel = path.replace(/^\/OpenSesame\//, "").replace(/^\//, "");
      if (
        rel.startsWith("/") ||
        rel.includes("\0") ||
        rel.includes("\\") ||
        rel.split("/").includes("..")
      )
        throw new Error("Invalid static path");
      const allowed = files.get(`/${rel}`);
      if (allowed)
        return send(
          readFileSync(allowed),
          MIME[extname(allowed)] ?? "application/octet-stream",
        );
      if (blocked.has(`/${rel}`))
        throw new Error("Static path is not an allowlisted file");
      return send(readFileSync(index), "text/html");
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  };
}
