import { describe, expect, it } from "vitest";
import { runHeadlessDeviceLogin } from "./main.js";

describe("example-headless", () => {
  it("completes mock device login without printing device_code", async () => {
    process.env.MOCK_DEVICE_FLOW = "1";
    const result = await runHeadlessDeviceLogin({
      sleep: async () => undefined,
    });
    expect(result.userCode).toBe("HEAD-LESS");
    expect(result.accessTokenPresent).toBe(true);
  });
});
