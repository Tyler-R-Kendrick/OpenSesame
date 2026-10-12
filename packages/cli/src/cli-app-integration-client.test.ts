import { cliAppIntegrationPolicyDocument } from "@opensesame/app-core/lib/cli-app-integration/policy.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCliAppIntegrationPort } from "./cli-app-integration-client.js";
import { humanRevealAppIntegrationRefusal } from "./reveal-gate.js";

describe("cli app integration client (production)", () => {
  const priorDaemon = process.env.OPENSESAME_DAEMON_API;
  const priorListen = process.env.OPENSESAME_DAEMON_LISTEN;
  const priorSeam = process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM;

  afterEach(() => {
    if (priorDaemon === undefined) {
      Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
    } else {
      process.env.OPENSESAME_DAEMON_API = priorDaemon;
    }
    if (priorListen === undefined) {
      Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_LISTEN");
    } else {
      process.env.OPENSESAME_DAEMON_LISTEN = priorListen;
    }
    if (priorSeam === undefined) {
      Reflect.deleteProperty(
        process.env,
        "OPENSESAME_CLI_APP_INTEGRATION_SEAM",
      );
    } else {
      process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM = priorSeam;
    }
  });

  it("ignores the legacy seam env when no daemon answers", async () => {
    process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM = "approve";
    Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_API");
    Reflect.deleteProperty(process.env, "OPENSESAME_DAEMON_LISTEN");
    process.env.OPENSESAME_DAEMON_API = "http://127.0.0.1:1";

    const refusal = await humanRevealAppIntegrationRefusal({
      verb: "read",
      reveal: true,
      desktop: true,
      reference: "op://v/i/f",
      stdinIsTty: true,
      stdoutIsTty: true,
      appIntegration: createCliAppIntegrationPort(),
    });
    expect(refusal).toBe(
      cliAppIntegrationPolicyDocument.messages.appUnavailable,
    );
  });
});
