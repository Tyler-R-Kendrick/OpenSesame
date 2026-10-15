import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SECRET_MASK,
  createSecretMasker,
  runChildWithValues,
  withMountFiles,
} from "./parity-node.js";

describe("secret masking", () => {
  it("masks values split across output chunks", () => {
    const masker = createSecretMasker(["private-canary"]);
    const shown =
      masker.push("value is priv") +
      masker.push("ate-canary ok\n") +
      masker.flush();
    expect(shown).toBe(`value is ${SECRET_MASK} ok\n`);
    expect(shown).not.toContain("private-canary");
  });

  it("masks the newline-stripped form of a value", () => {
    const masker = createSecretMasker(["private-canary\n"]);
    const shown = masker.push("echo private-canary\n") + masker.flush();
    expect(shown).toBe(`echo ${SECRET_MASK}\n`);
  });

  it("leaves output without secrets untouched", () => {
    const masker = createSecretMasker(["", "private-canary"]);
    const shown = masker.push("ordinary log line\n") + masker.flush();
    expect(shown).toBe("ordinary log line\n");
  });
});

describe("mount files", () => {
  it("materializes owner-only files and removes them afterwards", async () => {
    let seen = "";
    const paths = await withMountFiles(
      [{ name: "CERT_FILE", value: "pem-bytes" }],
      async (materialized) => {
        seen = materialized.CERT_FILE ?? "";
        expect(existsSync(seen)).toBe(true);
        return materialized;
      },
    );
    expect(paths.CERT_FILE).toBe(seen);
    expect(existsSync(seen)).toBe(false);
  });
});

describe("run with resolved values", () => {
  it("injects env and mount values while masking child output", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const script = [
      "const fs=require('node:fs');",
      "console.log('env='+process.env.API);",
      "console.log('plain='+process.env.PLAIN);",
      "console.log('mount='+fs.readFileSync(process.env.CERT_FILE,'utf8'));",
      "console.log('mode='+(fs.statSync(process.env.CERT_FILE).mode & 0o777).toString(8));",
      "console.log('token='+(process.env.OP_SERVICE_ACCOUNT_TOKEN ?? 'absent'));",
      "console.error('err='+process.env.API);",
      "process.exit(7);",
    ].join("");
    try {
      const code = await runChildWithValues(
        [process.execPath, "-e", script],
        { API: "private-canary", PLAIN: "ordinary-word" },
        [{ name: "CERT_FILE", value: "pem-canary" }],
        ["private-canary"],
      );
      expect(code).toBe(7);
      const out = stdout.mock.calls.map(([value]) => String(value)).join("");
      const err = stderr.mock.calls.map(([value]) => String(value)).join("");
      expect(out).toContain(`env=${SECRET_MASK}`);
      // A literal value the core did not list as secret stays readable.
      expect(out).toContain("plain=ordinary-word");
      expect(out).toContain(`mount=${SECRET_MASK}`);
      expect(out).toContain("token=absent");
      expect(out).not.toContain("private-canary");
      expect(out).not.toContain("pem-canary");
      expect(err).toContain(`err=${SECRET_MASK}`);
      expect(err).not.toContain("private-canary");
      if (process.platform !== "win32") expect(out).toContain("mode=600");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
