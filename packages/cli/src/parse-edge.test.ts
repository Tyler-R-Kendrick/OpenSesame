import { describe, expect, it } from "vitest";
import { parseArgs } from "./parse.js";

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

  it("rejects removed Identity and Host commands", () => {
    expect(() => parseArgs(["login"])).toThrow(/Unknown command: login/);
    expect(() => parseArgs(["auth", "status"])).toThrow(/Unknown command/);
    expect(() => parseArgs(["host", "health"])).toThrow(/Unknown command/);
  });
});

describe("parseArgs — global flags on vault commands", () => {
  it("parses --json on vault list", () => {
    expect(parseArgs(["vault", "list", "--json"])).toMatchObject({
      name: "vault-list",
      flags: { json: true },
    });
  });

  it("rejects a malformed --issuer URL", () => {
    expect(() =>
      parseArgs(["vault", "list", "--issuer", "not a url"]),
    ).toThrow();
  });
});
