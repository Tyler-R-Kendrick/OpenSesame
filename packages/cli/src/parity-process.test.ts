import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processFixture } from "./fixtures/password-agent/process.js";
const TOKEN = "ops_fake-token";
let directory: string;
let database: string;
let env: NodeJS.ProcessEnv;
let cli: Awaited<ReturnType<typeof processFixture>>["cli"];
let calls: Awaited<ReturnType<typeof processFixture>>["calls"];
describe("2password CLI process gauntlet", { timeout: 120_000 }, () => {
  beforeEach(async () => {
    const fixture = await processFixture();
    ({ directory, database, env, cli, calls } = fixture);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it("find inventory audit use real CLI with safe metadata and fuzzy suggestions", async () => {
    const found = await cli(["find", "database", "databse", "--desktop"]);
    expect(found.code).toBe(0);
    const search = JSON.parse(found.stdout);
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0].queries).toEqual(["database"]);
    expect(search.suggestions[0].query).toBe("databse");
    expect(search.suggestions[0].ref).toBe("op://Automation/Database/password");
    expect(found.stdout).not.toContain("original");
    const inventory = await cli(["inventory", "--desktop"]);
    expect(inventory.code).toBe(0);
    expect(inventory.stdout).toContain("https://example.com");
    expect(inventory.stdout).not.toContain("secret=canary");
    const audit = await cli(["audit", "--desktop"]);
    expect(audit.code).toBe(0);
    expect(audit.stdout).toContain("oldLogins");
    const report = JSON.parse(audit.stdout);
    expect(
      report.oldLogins.map((item: { title: string }) => item.title),
    ).toEqual(["Database"]);
    expect(report.urlsToReview[0].urls).toEqual(["https://example.com"]);
  });
  it("create stdin verifies one write and password compare apply preserves exact bytes", async () => {
    const created = await cli(
      [
        "create",
        "api-credential",
        "--title",
        "API",
        "--vault",
        "Automation",
        "--stdin",
        "--desktop",
      ],
      "private-api\n",
    );
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('"verified": true');
    expect(created.stdout).not.toContain("private-api");
    const writes = (await calls()).filter((call) =>
      call.args.includes("create"),
    );
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).not.toContain("private-api");
    const compared = await cli(
      ["password", "Database", "--vault", "Automation", "--stdin", "--desktop"],
      "original\n",
    );
    expect(compared.stdout).toContain('"matches": false');
    const changed = await cli(
      [
        "password",
        "Database",
        "--vault",
        "Automation",
        "--stdin",
        "--apply",
        "--desktop",
      ],
      "new-password\n",
    );
    expect(changed.code).toBe(0);
    expect(changed.stdout).toContain('"verified": true');
    const persisted = JSON.parse(await readFile(database, "utf8"));
    expect(persisted.items[0].fields[0].value).toBe("new-password\n");
    expect(
      (await calls()).filter((call) => call.args.includes("edit")),
    ).toHaveLength(1);
  });
  it("env write resolve and read deliberately materialize while run strips token and preserves child flags", async () => {
    const template = join(directory, "template.env");
    const target = join(directory, "resolved.env");
    expect((await cli(["env", "write", template, "API=op://v/i/f"])).code).toBe(
      0,
    );
    expect(
      (
        await cli([
          "env",
          "resolve",
          template,
          "--output",
          target,
          "--desktop",
          "--reveal",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await cli([
          "env",
          "resolve",
          template,
          "--output",
          target,
          "--desktop",
          "--reveal",
        ])
      ).stderr,
    ).toMatch(/stdin and stdout/);
    const readAttempt = await cli([
      "read",
      "op://v/i/f",
      "--desktop",
      "--reveal",
      "--account",
      "selected.account",
    ]);
    expect(readAttempt.code).toBe(1);
    expect(readAttempt.stderr).toMatch(/stdin and stdout/);
    env.OP_SERVICE_ACCOUNT_TOKEN = TOKEN;
    const script =
      "process.stdout.write(JSON.stringify({secret:process.env.API,token:process.env.OP_SERVICE_ACCOUNT_TOKEN,args:process.argv.slice(1)}));process.exit(7)";
    const ran = await cli([
      "run",
      "--env",
      "API=op://v/i/f",
      "--account",
      "work",
      "--",
      process.execPath,
      "-e",
      script,
      "--",
      "--json",
      "--api",
    ]);
    expect(ran.code).toBe(7);
    expect(JSON.parse(ran.stdout)).toEqual({
      secret: "private-canary\n",
      args: ["--json", "--api"],
    });
    const run = (await calls()).filter((call) => call.args[0] === "run").at(-1);
    expect(run?.token).toBe(TOKEN);
    expect(run?.args).toContain("--account");
    const fileRun = await cli([
      "env",
      "run",
      template,
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(process.env.API)",
    ]);
    expect(fileRun.code).toBe(0);
    expect(fileRun.stdout).toBe("private-canary\n");
  });
  it("service account setup verifies desktop creation token backup and saved authentication", async () => {
    env.OP_SERVICE_ACCOUNT_TOKEN = "ops_environment-must-not-win";
    const result = await cli([
      "service-account",
      "setup",
      "--vault",
      "Automation",
      "--save-vault",
      "Personal",
      "--write",
      "--expires-in",
      "90d",
      "--account",
      "selected.account",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"verified": true');
    expect(result.stdout).not.toContain(TOKEN);
    const entries = await calls();
    expect(
      entries.filter((call) => call.args[0] === "service-account"),
    ).toHaveLength(1);
    expect(
      entries.find((call) => call.args[0] === "service-account")?.token,
    ).toBeUndefined();
    expect(
      entries
        .find((call) => call.args[0] === "service-account")
        ?.args.slice(-2),
    ).toEqual(["--account", "selected.account"]);
    expect(
      entries.filter(
        (call) => call.args[0] === "item" && call.args[1] === "create",
      ),
    ).toHaveLength(1);
    env.OP_SERVICE_ACCOUNT_TOKEN = undefined;
    expect((await cli(["inventory"])).code).toBe(0);
    expect((await calls()).at(-1)?.token).toBe(TOKEN);
  });
  it("rejects duplicate creation and suppresses helper failure details without retrying writes", async () => {
    const duplicate = await cli(
      [
        "create",
        "api-credential",
        "--title",
        "Database",
        "--vault",
        "Automation",
        "--stdin",
        "--desktop",
      ],
      "private-api",
    );
    expect(duplicate.code).toBe(1);
    expect((await calls()).some((call) => call.args[1] === "create")).toBe(
      false,
    );
    const invalid = await cli(
      [
        "password",
        "Missing",
        "--vault",
        "Automation",
        "--stdin",
        "--apply",
        "--desktop",
      ],
      "new-canary",
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).not.toContain("new-canary");
    expect((await calls()).some((call) => call.args[1] === "edit")).toBe(false);
  });
  it("service account connect status recover forget and doctor run end to end", async () => {
    const connected = await cli(
      ["service-account", "connect", "--stdin"],
      `${TOKEN}\n`,
    );
    expect(connected.code).toBe(0);
    expect(connected.stdout).not.toContain(TOKEN);
    expect((await cli(["service-account", "status"])).stdout).toContain(
      '"verified": true',
    );
    expect((await cli(["service-account", "recover"])).code).toBe(0);
    const diagnostic = await cli(["doctor"]);
    expect(diagnostic.code).toBe(0);
    expect(diagnostic.stdout).toContain("saved service account");
    expect((await cli(["service-account", "forget"])).stdout).toContain(
      '"remoteRevoked": false',
    );
    expect((await cli(["service-account", "status"])).stdout).toContain(
      '"configured": false',
    );
  });
});
