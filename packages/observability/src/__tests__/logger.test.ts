import { Writable } from "node:stream";
import type { JsonObject } from "@opensesame/os-domain";
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
    });
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.apikey).toBe("[REDACTED]");
    expect(out.code).toBe(404);
    expect(out.authorization_code).toBe("[REDACTED]");
  });
  it("censors sensitive keys below the first level", () => {
    const out = redactDeep({
      ctx: { session: { access_token: "LEAK", safe: "ok" } },
      items: [{ claim_token: "LEAK2" }, { keep: 1 }],
    });
    expect(out.ctx.session.access_token).toBe("[REDACTED]");
    expect(out.ctx.session.safe).toBe("ok");
    expect(out.items[0]?.claim_token).toBe("[REDACTED]");
    expect(out.items[1]?.keep).toBe(1);
  });

  it("survives cycles without stalling", () => {
    const node: JsonObject = { password: "x" };
    node.self = node;
    const out = redactDeep(node);
    expect(out.password).toBe("[REDACTED]");
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
      verificationUriComplete: "https://app.example/claim#token=osc_clm_x.leak",
      nested: { verification_uri_complete: "https://x/?user_code=WXYZ-1234" },
      safe: "ok",
    });
    await new Promise((r) => setImmediate(r));
    const line = chunks.join("");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("osc_clm_secret");
    expect(line).not.toContain("ABCD-EFGH");
    expect(line).not.toContain("osc_clm_x.leak");
    expect(line).not.toContain("WXYZ-1234");
    expect(line).toContain("ok");
  });
});

describe("createLogger scrubs values, not just keys (ADR 0155)", () => {
  async function line(write: (log: ReturnType<typeof createLogger>) => void) {
    const { chunks, destination } = capture();
    const log = createLogger({ name: "test", level: "info", destination });
    write(log);
    await new Promise((r) => setImmediate(r));
    return chunks.join("");
  }

  it("scrubs a bearer in the message string", async () => {
    const out = await line((log) =>
      log.info(
        "claim opened https://app.example/claim#token=osc_clm_AbC.s3cr3tpart",
      ),
    );
    expect(out).not.toMatch(/osc_clm_|s3cr3tpart/);
    expect(out).toContain("claim opened");
  });

  it("scrubs an error's message and stack", async () => {
    const out = await line((log) =>
      log.error(
        { err: new Error("connect postgres://app:pw0rd@db/x refused") },
        "db down",
      ),
    );
    expect(out).not.toContain("pw0rd");
    expect(out).toContain("db down");
  });

  it("scrubs values under keys nobody thought to list", async () => {
    const out = await line((log) =>
      log.info({
        upstream: "GET https://h.example/x?api_key=k_live_1 -> 401",
        jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      }),
    );
    expect(out).not.toMatch(/k_live_1|eyJhbGci/);
    expect(out).toContain("401");
  });

  it("scrubs interpolation values", async () => {
    const out = await line((log) => log.info("failed for %s", "token=abc123"));
    expect(out).not.toContain("abc123");
  });
});
