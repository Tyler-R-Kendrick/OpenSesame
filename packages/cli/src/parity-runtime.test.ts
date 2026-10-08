import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OWNER_PASSWORD,
  execute,
  fixture,
  installRuntimeFixture,
  owner,
} from "./parity-runtime.test-support.js";

describe(
  "in-process CLI with the real provider transport",
  { timeout: 60_000 },
  () => {
    installRuntimeFixture();

    it("compares and updates a password without printing it, with one verified provider mutation", async () => {
      const base = [
        "password",
        "Database",
        "--vault",
        "Automation",
        "--stdin",
        "--desktop",
      ];
      const compared = await execute(base, "original");
      expect(compared.code, compared.stderr).toBe(0);
      expect(JSON.parse(compared.stdout)).toMatchObject({ matches: true });
      expect(
        (await fixture.calls()).some((call) => call.args[1] === "edit"),
      ).toBe(false);
      const applied = await execute(
        [...base, "--apply"],
        "replacement-private-canary",
      );
      expect(applied.code, applied.stderr).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        changed: true,
        verified: true,
      });
      expect(applied.stdout).not.toContain("replacement-private-canary");
      expect(
        (await fixture.calls()).filter((call) => call.args[1] === "edit"),
      ).toHaveLength(1);
      const database = JSON.parse(await readFile(fixture.database, "utf8"));
      expect(database.items[0].fields[0].value).toBe(
        "replacement-private-canary",
      );
      expect(database.items[0].urls[0].href).toBe(
        "https://example.com/oauth/callback?secret=canary#secret",
      );
    });

    it("requires explicit imported-field repair before touching a provider item", async () => {
      const database = JSON.parse(await readFile(fixture.database, "utf8"));
      database.items[0].fields.push({
        type: "STRING",
        value: "preserved-import",
      });
      await writeFile(fixture.database, JSON.stringify(database));
      const base = [
        "password",
        "Database",
        "--vault",
        "Automation",
        "--stdin",
        "--desktop",
      ];
      const invalid = await execute([...base, "--repair-imported-fields"]);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain("requires --apply");
      expect(await fixture.calls()).toEqual([]);
      const refused = await execute([...base, "--apply"]);
      expect(refused.code).toBe(1);
      expect(
        (await fixture.calls()).some((call) => call.args[1] === "edit"),
      ).toBe(false);
      const repaired = await execute([
        ...base,
        "--apply",
        "--repair-imported-fields",
      ]);
      expect(repaired.code, repaired.stderr).toBe(0);
      const persisted = JSON.parse(await readFile(fixture.database, "utf8"));
      expect(persisted.items[0].fields[1]).toMatchObject({
        id: "imported_field_2",
        type: "CONCEALED",
        value: "preserved-import",
      });
    });

    it("writes reference files privately and resolves them through the measured CLI without public plaintext", async () => {
      const source = join(fixture.directory, "references.env");
      const output = join(fixture.directory, "resolved.env");
      const written = await execute([
        "env",
        "write",
        source,
        "TOKEN=op://Automation/Database/password",
        "--desktop",
      ]);
      expect(written.code, written.stderr).toBe(0);
      expect(await readFile(source, "utf8")).toContain(
        "op://Automation/Database/password",
      );
      expect(await fixture.calls()).toEqual([]);
      const resolved = await execute([
        "env",
        "resolve",
        source,
        "--output",
        output,
        "--desktop",
      ]);
      expect(resolved.code, resolved.stderr).toBe(0);
      expect(JSON.parse(resolved.stdout)).toMatchObject({
        resolved: 1,
        plaintext: true,
      });
      expect(resolved.stdout).not.toContain("private-canary");
      expect(await readFile(output, "utf8")).toContain("private-canary");
      expect(await readFile(source, "utf8")).toContain(
        "op://Automation/Database/password",
      );
      if (process.platform !== "win32")
        expect((await stat(output)).mode & 0o777).toBe(0o600);
      const ambiguous = await execute([
        "env",
        "resolve",
        source,
        "--output",
        output,
        "--in-place",
        "--desktop",
      ]);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toContain("Choose exactly one");
      const inPlace = await execute([
        "env",
        "resolve",
        source,
        "--in-place",
        "--desktop",
      ]);
      expect(inPlace.code, inPlace.stderr).toBe(0);
      expect(await readFile(source, "utf8")).toContain("private-canary");
    });

    it("executes a child through real provider reference resolution and preserves its exit status", async () => {
      const result = await execute([
        "run",
        "--env",
        "TOKEN=op://Automation/Database/password",
        "--account",
        "controlled-account",
        "--desktop",
        "--",
        process.execPath,
        "-e",
        "process.exit(process.env.TOKEN==='private-canary\\n'?7:8)",
      ]);
      expect(result.code, result.stderr).toBe(7);
      const calls = await fixture.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toContain("--account");
      expect(result.stdout).not.toContain("private-canary");
    });

    it("connects, inspects and forgets a controlled service account without revealing its token", async () => {
      const connected = await execute(
        ["service-account", "connect", "--stdin", "--name", "Runtime account"],
        "ops_fake-token",
      );
      expect(connected.code, connected.stderr).toBe(0);
      expect(JSON.parse(connected.stdout)).toMatchObject({
        configured: true,
        name: "Runtime account",
        verified: true,
      });
      expect(connected.stdout).not.toContain("ops_fake-token");
      const status = await execute(["service-account", "status"]);
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        configured: true,
        name: "Runtime account",
      });
      const diagnostic = await execute(["doctor"]);
      expect(diagnostic.code, diagnostic.stderr).toBe(0);
      expect(JSON.parse(diagnostic.stdout)).toMatchObject({
        auth: "saved service account",
        op: "2.32.0",
        accounts: 0,
      });
      const forgotten = await execute(["service-account", "forget"]);
      expect(forgotten.code, forgotten.stderr).toBe(0);
      const empty = await execute(["service-account", "status"]);
      expect(JSON.parse(empty.stdout)).toMatchObject({
        configured: false,
        recoverable: false,
      });
      expect(
        (await fixture.calls()).some((call) => call.token === "ops_fake-token"),
      ).toBe(true);
    });

    it("creates a narrowly scoped service account and recovers its saved settings without issuing another token", async () => {
      const setup = await execute([
        "service-account",
        "setup",
        "--vault",
        "Automation",
        "--save-vault",
        "Personal",
        "--name",
        "Runtime automation",
        "--write",
        "--expires-in",
        "90d",
        "--account",
        "controlled-account",
      ]);
      expect(setup.code, setup.stderr).toBe(0);
      expect(JSON.parse(setup.stdout)).toMatchObject({
        configured: true,
        write: true,
        verified: true,
      });
      expect(setup.stdout).not.toContain("ops_fake-token");
      const issuance = (await fixture.calls()).filter(
        (call) => call.args[0] === "service-account",
      );
      expect(issuance).toHaveLength(1);
      expect(issuance[0]?.args).toContain(
        `${"b".repeat(26)}:read_items,write_items`,
      );
      expect(issuance[0]?.args).toContain("90d");
      const recovered = await execute(["service-account", "recover"]);
      expect(recovered.code, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        configured: true,
        verified: true,
      });
      expect(
        (await fixture.calls()).filter(
          (call) => call.args[0] === "service-account",
        ),
      ).toHaveLength(1);
    });

    it("runs a private reference-file snapshot through the provider and diagnoses explicit desktop or environment authentication", async () => {
      const file = join(fixture.directory, "child.env");
      await writeFile(file, "TOKEN=op://Automation/Database/password\n", {
        mode: 0o600,
      });
      const result = await execute([
        "env",
        "run",
        file,
        "--desktop",
        "--",
        process.execPath,
        "-e",
        "process.exit(process.env.TOKEN==='private-canary\\n'?9:10)",
      ]);
      expect(result.code, result.stderr).toBe(9);
      expect(result.stdout).not.toContain("private-canary");
      const desktop = await execute(["doctor", "--desktop"]);
      expect(JSON.parse(desktop.stdout)).toMatchObject({
        auth: "desktop app",
        op: "2.32.0",
      });
      vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "ops_environment-runtime");
      const environment = await execute(["doctor"]);
      expect(JSON.parse(environment.stdout)).toMatchObject({
        auth: "environment service account",
        op: "2.32.0",
      });
    });

    it("refuses private environment publication after entering a synthetic realm", async () => {
      owner.lock();
      await owner.createGuest({ decoy: true, isolated: true });
      const target = join(fixture.directory, "forbidden.env");
      const refused = await execute([
        "env",
        "write",
        target,
        "TOKEN=op://Automation/Database/password",
        "--desktop",
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fixture.calls()).toEqual([]);
      owner.lock();
      owner.rehydrate();
      await owner.unlock(OWNER_PASSWORD);
      expect(
        (
          await execute([
            "env",
            "write",
            target,
            "TOKEN=op://Automation/Database/password",
            "--desktop",
          ])
        ).code,
      ).toBe(0);
    });
  },
);
