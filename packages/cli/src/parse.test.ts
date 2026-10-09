import { describe, expect, it } from "vitest";
import { SessionFileSchema, helpText, parseArgs } from "./parse.js";

describe("parseArgs", () => {
  it("parses login --device --json", () => {
    const cmd = parseArgs(["login", "--device", "--json"]);
    expect(cmd).toEqual({
      name: "login",
      mode: "device",
      qrPreference: "auto",
      flags: { json: true },
    });
  });

  it("parses login --device --qr and --no-qr", () => {
    expect(parseArgs(["login", "--device", "--qr"])).toMatchObject({
      name: "login",
      qrPreference: "on",
    });
    expect(parseArgs(["login", "--device", "--no-qr"])).toMatchObject({
      name: "login",
      qrPreference: "off",
    });
  });

  it("parses login --loopback", () => {
    const cmd = parseArgs(["login", "--loopback"]);
    expect(cmd.name).toBe("login");
    if (cmd.name === "login") expect(cmd.mode).toBe("loopback");
  });

  it("parses auth status", () => {
    expect(parseArgs(["auth", "status"]).name).toBe("auth-status");
  });

  it("parses project create --temporary", () => {
    const cmd = parseArgs([
      "project",
      "create",
      "--temporary",
      "--name",
      "demo",
      "--issuer",
      "http://127.0.0.1:8788",
    ]);
    expect(cmd).toMatchObject({
      name: "project-create",
      temporary: true,
      projectName: "demo",
      flags: { json: false, issuer: "http://127.0.0.1:8788" },
    });
  });

  it("parses claim poll and agent init --anonymous", () => {
    expect(
      parseArgs(["claim", "poll", "clm_1", "--token", "osc_clm_abc"]),
    ).toMatchObject({
      name: "claim-poll",
      claimId: "clm_1",
      claimToken: "osc_clm_abc",
    });
    // Claim state is not readable by id alone.
    expect(() => parseArgs(["claim", "poll", "clm_1"])).toThrow(/claim token/);
    expect(
      parseArgs(["agent", "init", "--anonymous", "--name", "bot"]),
    ).toMatchObject({
      name: "agent-init",
      anonymous: true,
      displayName: "bot",
    });
  });

  it("refuses to poll a claim without its token", () => {
    expect(() => parseArgs(["claim", "poll", "clm_1"])).toThrow(/claim token/);
  });

  it("parses host health", () => {
    const cmd = parseArgs([
      "host",
      "health",
      "--host",
      "http://127.0.0.1:8787",
    ]);
    expect(cmd).toMatchObject({
      name: "host-health",
      hostUrl: "http://127.0.0.1:8787",
    });
  });

  it("help text documents bin name", () => {
    expect(helpText()).toContain("opensesame-id");
    expect(helpText()).toContain("opensesame-identity");
    expect(helpText()).toContain("host health");
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
