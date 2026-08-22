import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import { runHeadlessDeviceLogin } from "./main.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — example-headless", () => {
  it("property: mock device login completes with a user code only", async () => {
    process.env.MOCK_DEVICE_FLOW = "1";
    const result = await runHeadlessDeviceLogin({
      sleep: async () => undefined,
    });
    expect(result.userCode).toBe("HEAD-LESS");
    expect(result.accessTokenPresent).toBe(true);
  });

  it("adversarial: instructions refuse to print device_code", () => {
    assertSourceOrder(readFileSync(join(here, "main.ts"), "utf8"), [
      "client.formatInstructions(start)",
      'instructions.includes("DO_NOT_PRINT")',
      "/device_code/iu.test(instructions)",
      'throw new Error("device_code leaked into user instructions")',
    ]);
  });

  it("chaos: expires_in of 0 must not be treated as a default spin", () => {
    const src = readFileSync(
      join(here, "../../../packages/sdk-cli/src/device-flow.ts"),
      "utf8",
    );
    expect(src).toContain("data.expires_in < 0");
  });

  it("contract: mock device payload uses DO_NOT_PRINT as the device_code", () => {
    const src = readFileSync(join(here, "main.ts"), "utf8");
    expect(src).toContain('device_code: "DO_NOT_PRINT"');
    expect(src).toContain('user_code: "HEAD-LESS"');
  });
});
