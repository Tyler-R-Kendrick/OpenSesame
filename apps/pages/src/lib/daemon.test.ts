import { describe, expect, it } from "vitest";
import { probeDaemon } from "./daemon.js";

describe("daemon pairing", () => {
  it("refuses a daemon URL this page may not call", async () => {
    await expect(probeDaemon("http://10.0.0.5:18790")).rejects.toThrow(
      /not one this page may call/,
    );
    await expect(probeDaemon("not-a-url")).rejects.toThrow(
      /not one this page may call/,
    );
  });
});
