// A provider that refuses web pages: an HTTPS server standing in for
// `api.plivo.com` (the browser is told to resolve that name to it) whose
// answers carry no CORS header at all, so a page can never read them. It
// records what each request carried, to prove what the bridge did and did not
// send. The certificate is made for the run and trusted by no one else.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

export const GOOD = "Basic Z29vZDprZXk=";

export async function startProvider() {
  const dir = mkdtempSync(path.join(tmpdir(), "opensesame-bridge-cert-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=api.plivo.com",
    "-addext",
    "subjectAltName=DNS:api.plivo.com",
  ]);
  const seen = [];
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
      });
      if (request.method === "OPTIONS") {
        response.writeHead(403).end();
        return;
      }
      if (request.url?.startsWith("/redirect")) {
        response
          .writeHead(302, { location: "https://api.plivo.com/v1/ok" })
          .end();
        return;
      }
      const authorized = request.headers.authorization === GOOD;
      response.writeHead(authorized ? 200 : 401, {
        "content-type": "application/json",
        "set-cookie": "tracker=1",
      });
      response.end(
        JSON.stringify(
          authorized ? { auth_id: "MAGOOD" } : { error: "unauthorized" },
        ),
      );
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    seen,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
