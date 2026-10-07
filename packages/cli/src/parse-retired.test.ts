import { describe, expect, it } from "vitest";
import { parseArgs } from "./parse.js";

describe("human retired-credential grammar", () => {
  it("requires risk acknowledgement and defaults to reject", () => {
    expect(() => parseArgs(["vault", "retired-credentials", "enroll"])).toThrow(
      /acknowledge-password-verifier-risk/,
    );
    expect(
      parseArgs([
        "vault",
        "retired-credentials",
        "enroll",
        "--acknowledge-password-verifier-risk",
      ]),
    ).toMatchObject({ name: "vault-retired-enroll", response: "reject" });
    expect(
      parseArgs([
        "vault",
        "retired-credentials",
        "enroll",
        "--acknowledge-password-verifier-risk",
        "--response",
        "synthetic_decoy",
      ]),
    ).toMatchObject({
      name: "vault-retired-enroll",
      response: "synthetic_decoy",
    });
  });
  it("accepts metadata management and rejects secrets or dangerous policies", () => {
    expect(
      parseArgs(["vault", "retired-credentials", "status", "--json"]).name,
    ).toBe("vault-retired-status");
    expect(
      parseArgs(["vault", "retired-credentials", "remove", "trap-id"]),
    ).toMatchObject({ name: "vault-retired-remove", id: "trap-id" });
    expect(parseArgs(["vault", "retired-credentials", "clear"]).name).toBe(
      "vault-retired-clear",
    );
    for (const args of [
      ["--password", "secret"],
      ["secret"],
      ["--response", "wipe"],
      ["--response", "visible_items"],
    ])
      expect(() =>
        parseArgs([
          "vault",
          "retired-credentials",
          "enroll",
          "--acknowledge-password-verifier-risk",
          ...args,
        ]),
      ).toThrow();
    expect(() => parseArgs(["vault", "retired-credentials", "remove"])).toThrow(
      /trap id/,
    );
  });
});
