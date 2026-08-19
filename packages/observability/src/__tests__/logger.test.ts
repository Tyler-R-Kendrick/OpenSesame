import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactDeep } from "../logger.js";

function capture() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { chunks, destination };
}

describe("redactDeep", () => {
  it("redacts api_key and leaves diagnostic `code` fields", () => {
    const out = redactDeep({
      api_key: "sk_live",
      apikey: "sk_live2",
      code: 404,
      authorization_code: "leak",
    }) as Record<string, unknown>;
    expect(out.api_key).toBe("[Redacted]");
    expect(out.apikey).toBe("[Redacted]");
    expect(out.code).toBe(404);
    expect(out.authorization_code).toBe("[Redacted]");
  });
  it("censors sensitive keys below the first level", () => {
    const out = redactDeep({
      ctx: { session: { access_token: "LEAK", safe: "ok" } },
      items: [{ claim_token: "LEAK2" }, { keep: 1 }],
    }) as {
      ctx: { session: Record<string, unknown> };
      items: Array<Record<string, unknown>>;
    };
    expect(out.ctx.session.access_token).toBe("[Redacted]");
    expect(out.ctx.session.safe).toBe("ok");
    expect(out.items[0]?.claim_token).toBe("[Redacted]");
    expect(out.items[1]?.keep).toBe(1);
  });

  it("survives cycles without stalling", () => {
    const node: Record<string, unknown> = { password: "x" };
    node.self = node;
    const out = redactDeep(node) as Record<string, unknown>;
    expect(out.password).toBe("[Redacted]");
    expect(out.self).toBe("[Circular]");
  });
});

describe("createLogger", () => {
  it("redacts deeply nested tokens", async () => {
    const { chunks, destination } = capture();
    const log = createLogger({ name: "test", level: "info", destination });
    log.info({
      ctx: { session: { access_token: "DEEP-LEAK", nested: { pin: "1234" } } },
      list: [{ device_code: "DC-LEAK" }],
      safe: "ok",
    });
    await new Promise((r) => setImmediate(r));
    const line = chunks.join("");
    expect(line).not.toContain("DEEP-LEAK");
    expect(line).not.toContain("DC-LEAK");
    expect(line).not.toContain("1234");
    expect(line).toContain("ok");
  });

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
