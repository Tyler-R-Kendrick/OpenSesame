import { afterEach, describe, expect, it } from "vitest";
import { startCliAppIntegrationFakeDaemon } from "./fixtures/cli-app-integration-fake-daemon.js";
import {
  isLoopbackDaemonBase,
  verifyLocalDaemonForCliAppIntegration,
} from "./daemon-pin.js";

describe("daemon pin for CLI app integration", () => {
  it("accepts loopback daemon URLs only", () => {
    expect(isLoopbackDaemonBase("http://127.0.0.1:18790")).toBe(true);
    expect(isLoopbackDaemonBase("http://localhost:18790")).toBe(true);
    expect(isLoopbackDaemonBase("https://daemon.example.test")).toBe(false);
  });

  it("rejects the journey fake daemon that auto-approves ensure", async () => {
    const fake = await startCliAppIntegrationFakeDaemon();
    try {
      expect(await verifyLocalDaemonForCliAppIntegration(fake.baseUrl)).toBe(
        false,
      );
    } finally {
      await fake.close();
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

  it("fails closed when OPENSESAME_DAEMON_API points at the auto-approve stub", async () => {
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
      expect(decision).toBe("unavailable");
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
