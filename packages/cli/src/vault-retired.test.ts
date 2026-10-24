import type {
  LocalRetiredInspection,
  LocalVaultSecurityPort,
} from "@opensesame/vault-core/local-vault-security.js";
import { afterEach, expect, it, vi } from "vitest";
import { parseArgs } from "./parse.js";
import { runCli } from "./run.js";
afterEach(() => vi.restoreAllMocks());
const inspection: LocalRetiredInspection = {
  traps: [],
  events: [],
  stale: false,
};
const secret = "never-print-this-retired-password";
function output() {
  let text = "";
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    text += String(value);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    text += String(value);
    return true;
  });
  return () => text;
}
it("parses bounded explicit response enrollment without a credential in argv", () => {
  expect(
    parseArgs([
      "vault",
      "retired",
      "enroll",
      "--response",
      "reject",
      "--retention-days",
      "7",
    ]),
  ).toMatchObject({ name: "vault-retired", retentionMs: 7 * 86400000 });
  expect(() => parseArgs(["vault", "retired", "enroll"])).toThrow("--response");
  expect(() =>
    parseArgs([
      "vault",
      "retired",
      "enroll",
      "--response",
      "reject",
      "--retention-days",
      "91",
    ]),
  ).toThrow("Retention");
  expect(() =>
    parseArgs(["vault", "retired", "inspect", "--password", secret]),
  ).toThrow();
});
it("drives fresh primary and configured recovery then drains the exact challenge", async () => {
  const text = output();
  const answers = ["owner-secret", secret, secret, "one-use-factor"];
  const cancel = vi.fn(async () => {});
  const complete = vi.fn(async () => inspection);
  const beginRetired = vi.fn<LocalVaultSecurityPort["beginRetired"]>(
    async () => ({
      kind: "challenge",
      routes: ["recovery"],
      requestCode: async () => {
        throw new Error("wrong route");
      },
      complete,
      cancel,
    }),
  );
  const code = await runCli(
    [
      "vault",
      "retired",
      "enroll",
      "--response",
      "reject",
      "--factor",
      "recovery",
    ],
    {
      readPassword: async () => answers.shift() ?? "",
      retiredSecurity: {
        beginRetired,
        isRetiredResultCurrent: (value) => value === inspection,
      },
    },
  );
  expect(code).toBe(0);
  expect(beginRetired).toHaveBeenCalledWith(
    { kind: "password", secret: "owner-secret" },
    {
      kind: "change",
      change: { type: "enroll", password: secret, response: "reject" },
    },
  );
  expect(complete).toHaveBeenCalledWith({
    kind: "recovery",
    code: "one-use-factor",
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(text()).not.toMatch(/owner-secret|never-print|one-use-factor/);
});
it("does not publish an owner result after its session ended", async () => {
  const text = output();
  const code = await runCli(["vault", "retired", "inspect"], {
    readPassword: async () => "current",
    retiredSecurity: {
      beginRetired: async () => ({ kind: "complete", result: inspection }),
      isRetiredResultCurrent: () => false,
    },
  });
  expect(code).toBe(1);
  expect(text()).toContain("Authenticate again");
  expect(text()).not.toContain('"traps"');
});
it("drains a challenge when the terminal prompt fails", async () => {
  output();
  let prompts = 0;
  const cancel = vi.fn(async () => {});
  const complete = vi.fn();
  const code = await runCli(["vault", "retired", "inspect"], {
    readPassword: async () => {
      if (++prompts > 1) throw new Error("terminal ended");
      return "current";
    },
    retiredSecurity: {
      beginRetired: async () => ({
        kind: "challenge",
        routes: ["totp"],
        requestCode: vi.fn(),
        complete,
        cancel,
      }),
      isRetiredResultCurrent: () => false,
    },
  });
  expect(code).toBe(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
});
