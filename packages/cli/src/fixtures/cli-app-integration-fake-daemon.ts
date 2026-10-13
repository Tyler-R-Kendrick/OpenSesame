import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { CLI_APP_DAEMON_PIN_PROBE_SESSION_ID } from "../daemon-pin.js";

const ensurePath = cliAppIntegrationPolicy.daemonPaths.ensure;

function json(res: ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export interface CliAppIntegrationFakeDaemon {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Loopback stub for journey tests; not shipped in production code. */
/** Behaves like a real daemon for the pin: /health ok, probe pending, reveals approved. */
/** Journey env: loopback fake daemon, no seam/listen overrides. */
export async function envWithFakeCliAppIntegrationDaemon(
  base: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
  const fakeDaemon = await startCliAppIntegrationFakeDaemon();
  const env: NodeJS.ProcessEnv = {
    ...base,
    OPENSESAME_DAEMON_API: fakeDaemon.baseUrl,
  };
  env.OPENSESAME_DAEMON_LISTEN = undefined;
  Reflect.deleteProperty(env, "OPENSESAME_CLI_APP_INTEGRATION_SEAM");
  return { env, close: fakeDaemon.close };
}

export function startCliAppIntegrationFakeDaemon(): Promise<CliAppIntegrationFakeDaemon> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        json(res, { status: "ok" });
        return;
      }
      if (req.method === "POST" && req.url === ensurePath) {
        let raw = "";
        req.on("data", (chunk) => {
          raw += String(chunk);
        });
        req.on("end", () => {
          // A real daemon never instantly approves the pin's cold probe, so
          // the journey fake answers the probe with pending (pin passes) and
          // approves real reveals. Impostors that approve everything stay
          // rejected (see daemon-pin tests).
          let terminalSessionId = "";
          try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed === "object" && parsed !== null) {
              const value = (parsed as { terminalSessionId?: unknown })
                .terminalSessionId;
              if (typeof value === "string") terminalSessionId = value;
            }
          } catch {
            terminalSessionId = "";
          }
          json(res, {
            status:
              terminalSessionId === CLI_APP_DAEMON_PIN_PROBE_SESSION_ID
                ? "pending"
                : "approved",
          });
        });
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
