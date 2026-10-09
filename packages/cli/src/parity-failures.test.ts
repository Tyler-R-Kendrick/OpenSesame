import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processFixture } from "./fixtures/password-agent/process.js";
type Fixture = Awaited<ReturnType<typeof processFixture>>;
let fixture: Fixture;
const TOKEN = "ops_fake-token";
describe("2password CLI safety gauntlet", { timeout: 120_000 }, () => {
  beforeEach(async () => {
    fixture = await processFixture();
  });
  afterEach(async () => {
    await rm(fixture.directory, { recursive: true, force: true });
  });
  it("auth precedence uses environment token then saved token while desktop bypasses and orphan settings fail closed", async () => {
    const { cli, env, calls, directory } = fixture;
    expect(
      (await cli(["service-account", "connect", "--stdin"], TOKEN)).code,
    ).toBe(0);
    env.OP_SERVICE_ACCOUNT_TOKEN = "ops_environment";
    expect((await cli(["inventory"])).code).toBe(0);
    expect((await calls()).at(-1)?.token).toBe("ops_environment");
    expect((await cli(["inventory", "--desktop"])).code).toBe(0);
    expect((await calls()).at(-1)?.token).toBeUndefined();
    env.OP_SERVICE_ACCOUNT_TOKEN = undefined;
    expect((await cli(["inventory"])).code).toBe(0);
    expect((await calls()).at(-1)?.token).toBe(TOKEN);
    await unlink(join(directory, "state", "password-agent", "token"));
    const count = (await calls()).length;
    expect((await cli(["inventory"])).code).toBe(1);
    expect(await calls()).toHaveLength(count);
    expect((await cli(["inventory", "--desktop"])).code).toBe(0);
  });
  it("password unsafe templates require explicit repair and passkeys refuse mutation", async () => {
    const { cli, database, calls } = fixture;
    const db = JSON.parse(await readFile(database, "utf8"));
    db.items[0].fields.push({ type: "STRING", value: "imported-canary" });
    await writeFile(database, JSON.stringify(db));
    const base = [
      "password",
      "Database",
      "--vault",
      "Automation",
      "--stdin",
      "--apply",
      "--desktop",
    ];
    expect((await cli(base, "new")).code).toBe(1);
    expect((await calls()).some((call) => call.args[1] === "edit")).toBe(false);
    const repaired = await cli([...base, "--repair-imported-fields"], "new");
    expect(repaired.code, repaired.stderr).toBe(0);
    const persisted = JSON.parse(await readFile(database, "utf8"));
    expect(persisted.items[0].fields[1]).toMatchObject({
      id: "imported_field_2",
      type: "CONCEALED",
      value: "imported-canary",
    });
    persisted.items[0].passkeys = [{ id: "preserve" }];
    await writeFile(database, JSON.stringify(persisted));
    expect((await cli(base, "different")).code).toBe(1);
    expect(
      (await calls()).filter((call) => call.args[1] === "edit"),
    ).toHaveLength(1);
  });
  it("uncertain create and password readback suppress details and never retry a write", async () => {
    const { cli, env, calls, database } = fixture;
    env.PARITY_FAIL_READ = "1";
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
      "private-create-canary",
    );
    expect(created.code).toBe(1);
    expect(created.stderr).toContain("unverified");
    expect(created.stderr).not.toContain("private-");
    expect(
      (await calls()).filter((call) => call.args[1] === "create"),
    ).toHaveLength(1);
    const db = JSON.parse(await readFile(database, "utf8"));
    db.written = false;
    await writeFile(database, JSON.stringify(db));
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
      "private-password-canary",
    );
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("unverified");
    expect(changed.stderr).not.toContain("private-");
    expect(
      (await calls()).filter((call) => call.args[1] === "edit"),
    ).toHaveLength(1);
  });
  it("inventory ordering and audit duplicates machine credentials and transient URLs are safe", async () => {
    const { cli, database } = fixture;
    const db = JSON.parse(await readFile(database, "utf8"));
    db.items.push({
      ...db.items[0],
      id: "e".repeat(26),
      title: "database",
      category: "API_CREDENTIAL",
    });
    db.items.push({
      ...db.items[0],
      id: "f".repeat(26),
      title: "Alpha",
      category: "API_CREDENTIAL",
      tags: ["z", "a"],
    });
    await writeFile(database, JSON.stringify(db));
    const inventory = JSON.parse(
      (await cli(["inventory", "--desktop"])).stdout,
    ).items;
    expect(inventory.map((item: { title: string }) => item.title)).toEqual([
      "Alpha",
      "database",
      "Database",
    ]);
    expect(inventory[0].tags).toEqual(["a", "z"]);
    const result = await cli(["audit", "--desktop"]);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toEqual({ items: 3, tagged: 1, untagged: 2 });
    expect(report.duplicateTitles[0].items).toHaveLength(2);
    expect(
      report.untaggedMachineCredentials.map(
        (item: { title: string }) => item.title,
      ),
    ).toEqual(["database"]);
    expect(report.urlsToReview).toHaveLength(3);
    expect(
      report.urlsToReview.map((item: { reason: string }) => item.reason),
    ).toEqual(["transient-url", "transient-url", "transient-url"]);
    expect(result.stdout).not.toContain("secret=canary");
    expect(result.stdout).not.toContain("original");
  });
  it("partial service setup leaves token recoverable and refuses another account creation", async () => {
    const { cli, env, calls } = fixture;
    env.PARITY_FAIL_READ = "1";
    const args = [
      "service-account",
      "setup",
      "--vault",
      "Automation",
      "--save-vault",
      "Personal",
    ];
    const partial = await cli(args);
    expect(partial.code).toBe(1);
    expect(partial.stderr).toContain("backup is unverified");
    expect(
      (await calls()).filter((call) => call.args[0] === "service-account"),
    ).toHaveLength(1);
    expect((await cli(args)).code).toBe(1);
    expect(
      (await calls()).filter((call) => call.args[0] === "service-account"),
    ).toHaveLength(1);
    env.PARITY_FAIL_READ = undefined;
    expect((await cli(["service-account", "status"])).stdout).toContain(
      '"verified": true',
    );
  });
  it("piped env resolve never reaches a malformed secret batch and leaves output untouched", async () => {
    const { cli, env, directory, calls } = fixture;
    const template = join(directory, "input.env");
    const output = join(directory, "output.env");
    await writeFile(template, "TOKEN=op://v/i/f\n");
    await writeFile(output, "preserved");
    env.PARITY_BAD_BATCH = "1";
    const result = await cli([
      "env",
      "resolve",
      template,
      "--output",
      output,
      "--desktop",
      "--reveal",
    ]);
    // A pipe is not a person at a terminal, so the provider never runs.
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/stdin and stdout/);
    expect(result.stderr).not.toContain("malformed-secret-canary");
    expect(result.stdout).not.toContain("malformed-secret-canary");
    expect(await calls()).toEqual([]);
    expect(await readFile(output, "utf8")).toBe("preserved");
  });
  it("doctor enforces a deadline on a stuck helper without authentication or diagnostics", async () => {
    const { cli, env, calls } = fixture;
    env.PARITY_STUCK_VERSION = "1";
    const started = Date.now();
    const result = await cli(["doctor"]);
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    const report = JSON.parse(result.stdout);
    expect(report.op).toBeNull();
    expect(report.accounts).toBeNull();
    expect(result.stderr).toBe("");
    expect((await calls()).map((call) => call.args)).toEqual([["--version"]]);
  });
});

it("env run and assignment injection reject startup hooks before provider access and token exposure", async () => {
  const local = await processFixture();
  try {
    const marker = join(local.directory, "stolen-token");
    const preload = join(local.directory, "attacker.cjs");
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.env.OP_SERVICE_ACCOUNT_TOKEN??'missing')`,
    );
    local.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_dummy-secret-token";
    const file = join(local.directory, "attack.env");
    await writeFile(
      file,
      `NODE_OPTIONS=--require ${preload}\nAPI=op://v/i/f\n`,
    );
    const run = await local.cli([
      "env",
      "run",
      file,
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("startup");
    expect(await local.calls()).toEqual([]);
    await expect(readFile(marker)).rejects.toThrow();
    expect(run.stdout + run.stderr).not.toContain("ops_dummy-secret-token");
    const assignment = await local.cli([
      "run",
      "--env",
      "Node_Options=op://v/i/f",
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ]);
    expect(assignment.code).toBe(1);
    expect(await local.calls()).toEqual([]);
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await rm(local.directory, { recursive: true, force: true });
  }
}, 60000);

it("env run uses a private validated snapshot when the original template changes before provider launch", async () => {
  const local = await processFixture();
  try {
    const file = join(local.directory, "ordinary.env");
    await writeFile(file, "API=op://v/i/f\n");
    local.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_dummy-secret-token";
    local.env.PARITY_MUTATE_ENV_FILE = file;
    local.env.PARITY_ENV_REPLACEMENT =
      "NODE_OPTIONS=--require nonexistent-attack.cjs\n";
    // The selected child's functional response is captured by the test process.
    const result = await local.cli([
      "env",
      "run",
      file,
      "--account",
      "selected.account",
      "--",
      process.execPath,
      "-e",
      "require('node:fs').writeSync(1,JSON.stringify({api:process.env.API,token:process.env.OP_SERVICE_ACCOUNT_TOKEN??null}))",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      api: "private-canary\n",
      token: null,
    });
    expect(await readFile(file, "utf8")).toContain("NODE_OPTIONS");
    const call = (await local.calls()).at(-1);
    const snapshot = call?.args
      .find((arg) => arg.startsWith("--env-file="))
      ?.slice(11);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toBe(file);
    expect(call?.args).toContain("selected.account");
    if (!snapshot) throw new Error("Snapshot path missing");
    await expect(readFile(snapshot)).rejects.toThrow();
  } finally {
    await rm(local.directory, { recursive: true, force: true });
  }
}, 60000);
