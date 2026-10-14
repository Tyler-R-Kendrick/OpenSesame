import { createServer } from "node:http";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import {
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { tcpListenPort } from "./net-listen-port.js";

const ensurePath = cliAppIntegrationPolicy.daemonPaths.ensure;

export interface CliAppIntegrationFakeDaemon {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Loopback stub for journey tests; not shipped in production code. */
/** Journey env: loopback fake daemon, no seam/listen overrides. */
export async function envWithFakeCliAppIntegrationDaemon(
  base: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
  const fakeDaemon = await startCliAppIntegrationFakeDaemon();
  const env: NodeJS.ProcessEnv = {
    ...base,
    OPENSESAME_DAEMON_API: fakeDaemon.baseUrl,
  };
  Reflect.deleteProperty(env, "OPENSESAME_DAEMON_LISTEN");
  Reflect.deleteProperty(env, "OPENSESAME_CLI_APP_INTEGRATION_SEAM");
  return { env, close: fakeDaemon.close };
}

const pinProbeVerb = cliAppIntegrationPolicy.daemonPinProbeVerb;

export function startCliAppIntegrationFakeDaemon(): Promise<CliAppIntegrationFakeDaemon> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        const payload = JSON.stringify({ status: "ok" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      if (req.method === "POST" && req.url === ensurePath) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(chunk);
        });
        req.on("end", () => {
          let status = "approved";
          try {
            const parsed = overlapCast(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            const verb = isJsonObject(parsed) ? parsed.verb : undefined;
            if (isString(verb) && verb === pinProbeVerb) {
              status = "pending";
            }
          } catch {
            status = "denied";
          }
          const payload = JSON.stringify({ status });
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          });
          res.end(payload);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = tcpListenPort(server.address());
      if (port === null) {
        reject(new Error("fake daemon has no listen address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
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
