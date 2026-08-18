import { describe, expect, it } from "vitest";
import { assertSourceOrder } from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceFlowClient } from "./device-flow.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — CLI device flow", () => {
  it("source: expires_in of 0 is expiry, not a 15-minute default", () => {
    assertSourceOrder(readFileSync(join(here, "device-flow.ts"), "utf8"), [
      "this.#expiresAt = Date.now() +",
      "data.expires_in >= 0",
      "data.expires_in * 1000",
    ]);
  });

  it("contract: printed instructions never include device_code", () => {
    const client = new DeviceFlowClient({
      issuer: "http://127.0.0.1:8788",
      clientId: "cli",
    });
    const text = client.formatInstructions({
      userCode: "ABCD-EFGH",
      verificationUri: "http://127.0.0.1:5173/device",
      expiresIn: 600,
      intervalSeconds: 5,
    });
    expect(text).toContain("ABCD-EFGH");
    expect(text).not.toMatch(/SECRET|device_code/i);
  });
});
