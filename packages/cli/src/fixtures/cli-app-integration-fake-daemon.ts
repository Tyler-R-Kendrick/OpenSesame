import { createServer } from "node:http";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";

const ensurePath = cliAppIntegrationPolicy.daemonPaths.ensure;

export interface CliAppIntegrationFakeDaemon {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Loopback stub for journey tests; not shipped in production code. */
export function startCliAppIntegrationFakeDaemon(): Promise<CliAppIntegrationFakeDaemon> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === ensurePath) {
        const payload = JSON.stringify({ status: "approved" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fake daemon has no listen address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
    server.on("error", reject);
  });
}
