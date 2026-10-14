import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { overlapCast } from "@opensesame/os-domain";
import { cliAppIntegrationPolicy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackDaemonBase,
  verifyLocalDaemonForCliAppIntegration,
} from "./daemon-pin.js";
import {
  type CliAppIntegrationFakeDaemon,
  startCliAppIntegrationFakeDaemon,
} from "./fixtures/cli-app-integration-fake-daemon.js";
import { tcpListenPort } from "./fixtures/net-listen-port.js";

const ensurePath = cliAppIntegrationPolicy.daemonPaths.ensure;

async function startAutoApproveEnsureStub(): Promise<CliAppIntegrationFakeDaemon> {
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
      const bound: AddressInfo = overlapCast(server.address());
      const port = tcpListenPort(bound);
      if (port === null) {
        reject(new Error("stub has no listen address"));
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

describe("daemon pin for CLI app integration", () => {
  it("accepts loopback daemon URLs only", () => {
    expect(isLoopbackDaemonBase("http://127.0.0.1:18790")).toBe(true);
    expect(isLoopbackDaemonBase("http://localhost:18790")).toBe(true);
    expect(isLoopbackDaemonBase("https://daemon.example.test")).toBe(false);
  });

  it("accepts the journey fake daemon after pin probe returns pending", async () => {
    const fake = await startCliAppIntegrationFakeDaemon();
    try {
      expect(await verifyLocalDaemonForCliAppIntegration(fake.baseUrl)).toBe(
        true,
      );
    } finally {
      await fake.close();
    }
  });

  it("rejects a loopback stub that auto-approves the pin probe", async () => {
    const stub = await startAutoApproveEnsureStub();
    try {
      expect(await verifyLocalDaemonForCliAppIntegration(stub.baseUrl)).toBe(
        false,
      );
    } finally {
      await stub.close();
    }
  });
});

describe("createCliAppIntegrationPort with fake daemon", () => {
  const priorDaemon = process.env.OPENSESAME_DAEMON_API;

  afterEach(async () => {
    if (priorDaemon === undefined) {
      Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
    } else {
      process.env.OPENSESAME_DAEMON_API = priorDaemon;
    }
  });

  it("fails closed when OPENSESAME_DAEMON_API points at an auto-approve stub", async () => {
    const stub = await startAutoApproveEnsureStub();
    process.env.OPENSESAME_DAEMON_API = stub.baseUrl;
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
      await stub.close();
      if (priorDaemon === undefined) {
        Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
      } else {
        process.env.OPENSESAME_DAEMON_API = priorDaemon;
      }
    }
  });

  it("polls ensure on the journey fake daemon after pin verification", async () => {
    const fake = await startCliAppIntegrationFakeDaemon();
    process.env.OPENSESAME_DAEMON_API = fake.baseUrl;
    try {
      const { createCliAppIntegrationPort } = await import(
        "./cli-app-integration-client.js"
      );
      const decision = await createCliAppIntegrationPort().ensureReveal({
        verb: "read",
        terminalSessionId: "term-test",
      });
      expect(decision).toBe("approve");
    } finally {
      await fake.close();
      if (priorDaemon === undefined) {
        Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
      } else {
        process.env.OPENSESAME_DAEMON_API = priorDaemon;
      }
    }
  });
});
