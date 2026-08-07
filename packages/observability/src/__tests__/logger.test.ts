import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../logger.js";

describe("createLogger", () => {
  it("redacts tokens and codes", async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ name: "test", level: "info", destination });
    log.info({
      claimToken: "osc_clm_secret.token",
      userCode: "ABCD-EFGH",
      safe: "ok",
    });
    await new Promise((r) => setImmediate(r));
    const line = chunks.join("");
    expect(line).toContain("[Redacted]");
    expect(line).not.toContain("osc_clm_secret");
    expect(line).not.toContain("ABCD-EFGH");
    expect(line).toContain("ok");
  });
});
