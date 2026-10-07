import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  execute,
  fixture,
  installRuntimeFixture,
} from "./parity-runtime.test-support.js";

describe(
  "measured CLI item dispatch and output boundaries",
  { timeout: 60_000 },
  () => {
    installRuntimeFixture();

    it("returns metadata for find, inventory and audit; only an explicit human read returns exact secret bytes", async () => {
      for (const args of [["find", "Database"], ["inventory"], ["audit"]]) {
        const result = await execute([
          ...args,
          "--vault",
          "Automation",
          "--desktop",
        ]);
        expect(result.code, result.stderr).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        expect(result.stdout).not.toContain("private-canary");
        expect(result.stdout).not.toContain("original");
        expect(result.stdout).not.toContain("secret=canary");
      }
      const read = await execute([
        "read",
        "op://Automation/Database/password",
        "--desktop",
      ]);
      expect(read.code, read.stderr).toBe(0);
      expect(read.stdout).toBe("private-canary\n");
    });

    it("creates an API credential from private input and checks the stored identity without exposing its value", async () => {
      const created = await execute(
        [
          "create",
          "api-credential",
          "--title",
          "Runtime API",
          "--vault",
          "Automation",
          "--account",
          "controlled-account",
          "--url",
          "https://service.invalid",
          "--notes",
          "Controlled fixture",
          "--stdin",
          "--desktop",
        ],
        "created-private-canary",
      );
      expect(created.code, created.stderr).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({
        title: "Runtime API",
        verified: true,
      });
      expect(created.stdout).not.toContain("created-private-canary");
      const database = JSON.parse(await readFile(fixture.database, "utf8"));
      const stored = database.items.find(
        (item: { title: string }) => item.title === "Runtime API",
      );
      expect(stored).toMatchObject({ category: "API_CREDENTIAL" });
      expect(stored.fields).toContainEqual({
        id: "notesPlain",
        type: "STRING",
        label: "notesPlain",
        purpose: "NOTES",
        value: "Controlled fixture",
      });
      expect(stored.urls).toContainEqual({
        href: "https://service.invalid",
        primary: true,
      });
      expect(
        stored.fields.some(
          (field: { value: string }) =>
            field.value === "created-private-canary",
        ),
      ).toBe(true);
      const calls = await fixture.calls();
      expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
      for (const call of calls) {
        expect(call.args.slice(-2)).toEqual([
          "--account",
          "controlled-account",
        ]);
        expect(call.account).toBeUndefined();
      }
    });

    it("rejects missing references, ambiguous source flags and unexpected item options before provider effects", async () => {
      for (const args of [
        ["read"],
        ["find", "--unrecognized"],
        ["inventory", "extra"],
        ["create", "login", "--stdin"],
        ["create", "api-credential", "--title", "Missing vault", "--stdin"],
        [
          "password",
          "Database",
          "--vault",
          "Automation",
          "--stdin",
          "--clipboard",
        ],
        ["env", "write", "/unused"],
        ["service-account", "unknown"],
      ]) {
        const result = await execute([...args, "--desktop"]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("runtime-private-input");
      }
      expect(await fixture.calls()).toEqual([]);
    });
  },
);
