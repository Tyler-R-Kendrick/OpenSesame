import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

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
function confinedFile(dist, rel) {
  if (rel.includes("\0") || rel.includes("\\") || rel.split("/").includes(".."))
    throw new Error("Invalid static path");
  const root = realpathSync(dist);
  const file = resolve(root, rel);
  const inside = (candidate) => {
    const rest = relative(root, candidate);
    return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  };
  if (!inside(file) || (existsSync(file) && !inside(realpathSync(file))))
    throw new Error("Static path escapes build directory");
  return file;
}

export function browserCertStaticHandler(dist) {
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
      const file = confinedFile(dist, rel);
      if (rel && existsSync(file) && extname(file))
        return send(
          readFileSync(file),
          MIME[extname(file)] ?? "application/octet-stream",
        );
      return send(readFileSync(confinedFile(dist, "index.html")), "text/html");
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  };
}
