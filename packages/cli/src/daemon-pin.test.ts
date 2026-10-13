import { createServer } from "node:http";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackDaemonBase,
  verifyLocalDaemonForCliAppIntegration,
} from "./daemon-pin.js";

const ensurePath = cliAppIntegrationPolicy.daemonPaths.ensure;

/** Impostor stub for pin tests: /health looks real, ensure auto-approves. */
async function startAutoApproveImpostor(
  health: boolean,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        if (!health) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ok = JSON.stringify({ status: "ok" });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(ok),
        });
        res.end(ok);
        return;
      }
      if (!(req.method === "POST" && req.url === ensurePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = JSON.stringify(
        req.method === "GET" ? { status: "ok" } : { status: "approved" },
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("impostor has no listen address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
    server.on("error", reject);
  });
}

describe("daemon pin for CLI app integration", () => {
  it("accepts loopback daemon URLs only", () => {
    expect(isLoopbackDaemonBase("http://127.0.0.1:18790")).toBe(true);
    expect(isLoopbackDaemonBase("http://localhost:18790")).toBe(true);
    expect(isLoopbackDaemonBase("https://daemon.example.test")).toBe(false);
  });

  it("rejects a daemon without a health check", async () => {
    const impostor = await startAutoApproveImpostor(false);
    try {
      expect(
        await verifyLocalDaemonForCliAppIntegration(impostor.baseUrl),
      ).toBe(false);
    } finally {
      await impostor.close();
    }
  });

  it("rejects an impostor that auto-approves ensure despite healthy /health", async () => {
    const impostor = await startAutoApproveImpostor(true);
    try {
      expect(
        await verifyLocalDaemonForCliAppIntegration(impostor.baseUrl),
      ).toBe(false);
    } finally {
      await impostor.close();
    }
  });
});

describe("createCliAppIntegrationPort with impostor daemon", () => {
  const priorDaemon = process.env.OPENSESAME_DAEMON_API;

  afterEach(async () => {
    if (priorDaemon === undefined) {
      Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
    } else {
      process.env.OPENSESAME_DAEMON_API = priorDaemon;
    }
  });

  it("fails closed when OPENSESAME_DAEMON_API points at the auto-approve stub", async () => {
    const impostor = await startAutoApproveImpostor(true);
    process.env.OPENSESAME_DAEMON_API = impostor.baseUrl;
    try {
      const { createCliAppIntegrationPort } = await import(
        "./cli-app-integration-client.js"
      );
      const decision = await createCliAppIntegrationPort().ensureReveal({
        verb: "read",
        terminalSessionId: "term-test",
      });
      expect(decision).toBe("unavailable");
    } finally {
      await impostor.close();
      if (priorDaemon === undefined) {
        Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
      } else {
        process.env.OPENSESAME_DAEMON_API = priorDaemon;
      }
    }
  }, 15_000);
});
