import { describe, expect, it } from "vitest";
import { SessionFileSchema, helpText, parseArgs } from "./parse.js";

describe("parseArgs", () => {
  it("parses vault verify and ls", () => {
    expect(parseArgs(["vault", "verify", "./vault.osv"])).toMatchObject({
      name: "vault-verify",
      file: "./vault.osv",
    });
    expect(parseArgs(["vault", "ls", "./vault.osv"])).toMatchObject({
      name: "vault-ls",
      file: "./vault.osv",
    });
  });

  it("parses vault list", () => {
    expect(parseArgs(["vault", "list"]).name).toBe("vault-list");
  });

  it("refuses unknown top-level commands", () => {
    expect(() => parseArgs(["login", "--device"])).toThrow(/Unknown command/);
    expect(() => parseArgs(["host", "health"])).toThrow(/Unknown command/);
  });

  it("help text documents bin name and vault verbs", () => {
    expect(helpText()).toContain("opensesame-id");
    expect(helpText()).toContain("vault verify");
    expect(helpText()).not.toContain("host health");
  });
});

describe("SessionFileSchema", () => {
  it("accepts session without printing secrets in schema", () => {
    const parsed = SessionFileSchema.parse({
      accessToken: "at",
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-cli",
    });
    expect(parsed.accessToken).toBe("at");
  });
});
