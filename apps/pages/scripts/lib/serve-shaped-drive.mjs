// A drive reached the way Tailscale Serve exposes it (ADR 0144): HTTPS at
// `https://<machine>.<tailnet>.ts.net`, terminated in front of the daemon,
// which listens on loopback. Serve's certificate is publicly trusted; this
// one is minted here and trusted by the test browser alone. Chromium is told
// to resolve the tailnet name to this proxy, so the page, its CORS and its
// Local Network Access gate all see the address a real tailnet would give.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SERVE_HOST = "desk.tail4c2e.ts.net";

function mintCertificate(dir) {
  const key = path.join(dir, "serve.key");
  const cert = path.join(dir, "serve.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${SERVE_HOST}`,
      "-addext",
      `subjectAltName=DNS:${SERVE_HOST}`,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** 443 as Serve uses, where this process may bind it; another port if not. */
async function freePort() {
  for (const port of [443, 0]) {
    const found = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(null));
      probe.listen(port, "127.0.0.1", () => {
        const { port: bound } = probe.address();
        probe.close(() => resolve(bound));
      });
    });
    if (found !== null) return found;
  }
  throw new Error("serve-shaped drive: no port to listen on");
}

/**
 * Terminate TLS for `SERVE_HOST` and forward every request, untouched, to
 * the daemon at `upstream` (`http://127.0.0.1:<port>`).
 */
export async function serveShapedDrive(upstream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-shaped-"));
  const port = await freePort();
  const target = new URL(upstream);
  const server = https.createServer(mintCertificate(dir), (request, reply) => {
    const forward = new URL(request.url, upstream);
    const outbound = import("node:http").then(({ request: send }) =>
      send(
        {
          host: target.hostname,
          port: target.port,
          method: request.method,
          path: `${forward.pathname}${forward.search}`,
          headers: { ...request.headers, host: target.host },
        },
        (answer) => {
          reply.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(reply);
        },
      ),
    );
    outbound.then((upstreamRequest) => {
      upstreamRequest.on("error", () => {
        reply.writeHead(502);
        reply.end();
      });
      request.pipe(upstreamRequest);
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url =
    port === 443 ? `https://${SERVE_HOST}` : `https://${SERVE_HOST}:${port}`;
  return {
    url,
    /**
     * Chromium flags that send the tailnet name to this proxy, directly: a
     * tailnet name is never reached through an outbound proxy, and a sandbox
     * that sets one would otherwise tunnel it there and fail. The proxy's
     * address is classed `local`, as a tailnet's 100.64.0.0/10 address is,
     * so the page's `targetAddressSpace: "local"` hint matches as it would on
     * a real tailnet (a mismatch is a network error).
     */
    browserArgs: [
      `--host-resolver-rules=MAP ${SERVE_HOST} 127.0.0.1`,
      `--ip-address-space-overrides=127.0.0.1:${port}=local`,
      "--no-proxy-server",
    ],
    close() {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
