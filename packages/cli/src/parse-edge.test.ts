import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./parse.js";

const TOUCHED_ENV = ["OPENSESAME_CLAIM_TOKEN", "OPENSESAME_HOST_API"] as const;

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe("parseArgs — help and unknown commands", () => {
  it("defaults to help with no arguments", () => {
    expect(parseArgs([])).toEqual({ name: "help" });
  });

  it("treats --help and -h as help", () => {
    expect(parseArgs(["--help"])).toEqual({ name: "help" });
    expect(parseArgs(["-h"])).toEqual({ name: "help" });
    expect(parseArgs(["help"])).toEqual({ name: "help" });
  });

  it("rejects an unknown command with its name in the message", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(
      /Unknown command: frobnicate/,
    );
  });

  it("rejects a known group with an unknown subcommand", () => {
    // "auth" without "status" falls through to the unknown-command error.
    expect(() => parseArgs(["auth"])).toThrow(/Unknown command: auth/);
    expect(() => parseArgs(["host", "restart"])).toThrow(/Unknown command/);
  });
});

describe("parseArgs — global flags", () => {
  it("parses --api and --client-id", () => {
    const cmd = parseArgs([
      "whoami",
      "--api",
      "https://api.example.test",
      "--client-id",
      "my-client",
    ]);
    expect(cmd).toEqual({
      name: "whoami",
      flags: {
        json: false,
        api: "https://api.example.test",
        clientId: "my-client",
      },
    });
  });

  it("rejects a malformed --issuer URL", () => {
    expect(() => parseArgs(["whoami", "--issuer", "not a url"])).toThrow();
  });

  it("rejects a malformed --api URL", () => {
    expect(() => parseArgs(["whoami", "--api", ":::"])).toThrow();
  });
});

describe("parseArgs — login modes", () => {
  it("defaults to auto mode and auto QR", () => {
    expect(parseArgs(["login"])).toMatchObject({
      name: "login",
      mode: "auto",
      qrPreference: "auto",
    });
  });

  it("treats --no-browser as device mode", () => {
    expect(parseArgs(["login", "--no-browser"])).toMatchObject({
      name: "login",
      mode: "device",
    });
  });

  it("treats --guest as an alias for --anonymous", () => {
    expect(parseArgs(["login", "--guest"])).toMatchObject({
      name: "login",
      mode: "anonymous",
    });
  });

  it("lets --anonymous win over --device", () => {
    expect(parseArgs(["login", "--device", "--anonymous"])).toMatchObject({
      name: "login",
      mode: "anonymous",
    });
  });

  it("lets --no-qr win over --qr", () => {
    expect(parseArgs(["login", "--qr", "--no-qr"])).toMatchObject({
      qrPreference: "off",
    });
  });
});

describe("parseArgs — project create", () => {
  it("takes the project name positionally", () => {
    expect(parseArgs(["project", "create", "my-proj"])).toMatchObject({
      name: "project-create",
      temporary: false,
      projectName: "my-proj",
    });
  });

  it("defaults the project name when none is given", () => {
    expect(parseArgs(["project", "create", "--temporary"])).toMatchObject({
      projectName: "tmp-project",
    });
  });
});

describe("parseArgs — claim poll", () => {
  it("takes the claim id from --id", () => {
    expect(
      parseArgs(["claim", "poll", "--id", "clm_9", "--token", "osc_clm_x"]),
    ).toMatchObject({ claimId: "clm_9", claimToken: "osc_clm_x" });
  });

  it("requires a claim id", () => {
    expect(() => parseArgs(["claim", "poll"])).toThrow(/claim id/);
  });

  it("reads the claim token from OPENSESAME_CLAIM_TOKEN", () => {
    process.env.OPENSESAME_CLAIM_TOKEN = "osc_clm_env";
    expect(parseArgs(["claim", "poll", "clm_1"])).toMatchObject({
      claimToken: "osc_clm_env",
    });
  });

  it("prefers --token over the environment", () => {
    process.env.OPENSESAME_CLAIM_TOKEN = "osc_clm_env";
    expect(
      parseArgs(["claim", "poll", "clm_1", "--token", "osc_clm_flag"]),
    ).toMatchObject({ claimToken: "osc_clm_flag" });
  });

  it("takes the claim token positionally as a last resort", () => {
    expect(parseArgs(["claim", "poll", "clm_1", "osc_clm_pos"])).toMatchObject({
      claimId: "clm_1",
      claimToken: "osc_clm_pos",
    });
  });
});

describe("parseArgs — agent init", () => {
  it("takes the display name positionally", () => {
    expect(parseArgs(["agent", "init", "robo"])).toMatchObject({
      name: "agent-init",
      anonymous: false,
      displayName: "robo",
    });
  });

  it("defaults the display name", () => {
    expect(parseArgs(["agent", "init", "--anonymous"])).toMatchObject({
      displayName: "anonymous-agent",
    });
  });
});

describe("parseArgs — host commands", () => {
  it("defaults the host URL to the local gateway", () => {
    expect(parseArgs(["host", "health"])).toMatchObject({
      name: "host-health",
      hostUrl: "http://127.0.0.1:8787",
    });
    expect(parseArgs(["host", "discover"])).toMatchObject({
      name: "host-discover",
      hostUrl: "http://127.0.0.1:8787",
    });
  });

  it("reads the host URL from OPENSESAME_HOST_API", () => {
    process.env.OPENSESAME_HOST_API = "http://127.0.0.1:9999";
    expect(parseArgs(["host", "health"])).toMatchObject({
      hostUrl: "http://127.0.0.1:9999",
    });
    expect(parseArgs(["host", "discover"])).toMatchObject({
      hostUrl: "http://127.0.0.1:9999",
    });
  });

  it("prefers --host over the environment", () => {
    process.env.OPENSESAME_HOST_API = "http://127.0.0.1:9999";
    expect(
      parseArgs(["host", "discover", "--host", "http://127.0.0.1:8787"]),
    ).toMatchObject({ hostUrl: "http://127.0.0.1:8787" });
  });
});
