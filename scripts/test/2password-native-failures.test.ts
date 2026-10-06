import { execFile } from "node:child_process";
import { chmod, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeProcessFixture as processFixture } from "../../packages/cli/src/fixtures/password-agent/native-process.js";
type Fixture = Awaited<ReturnType<typeof processFixture>>;
let fixture: Fixture;
const TOKEN = "ops_fake-token";
describe("2password native CLI safety gauntlet", { timeout: 30_000 }, () => {
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
    await unlink(join(directory, "token"));
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
  it("encrypted service settings reject corruption without falling back to desktop", async () => {
    const { cli, directory, calls } = fixture;
    expect(
      (await cli(["service-account", "connect", "--stdin"], TOKEN)).code,
    ).toBe(0);
    const file = join(directory, "config", "opensesame", "password-agent.json");
    const settings = JSON.parse(await readFile(file, "utf8"));
    settings.ciphertext = "corrupt";
    await writeFile(file, JSON.stringify(settings));
    const count = (await calls()).length;
    expect((await cli(["inventory"])).code).toBe(1);
    expect(await calls()).toHaveLength(count);
    expect((await cli(["inventory", "--desktop"])).code).toBe(0);
  });
  it("doctor enforces a deadline on a stuck helper without authentication or diagnostics", async () => {
    const { cli, env, calls } = fixture;
    env.PARITY_STUCK_VERSION = "1";
    const started = Date.now();
    const result = await cli(["doctor"]);
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const report = JSON.parse(result.stdout);
    expect(report.opVersion).toBeNull();
    expect(report.accounts).toBeNull();
    expect(result.stderr).toBe("");
    expect((await calls()).map((call) => call.args)).toEqual([["--version"]]);
  });
  it("trusted helpers ignore planted cwd and relative PATH executables and preload hooks", async () => {
    const { cli, env, directory, calls } = fixture;
    const marker = join(directory, "compromised");
    const trap = join(directory, "op");
    await writeFile(
      trap,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'compromised');process.exit(99)`,
    );
    await chmod(trap, 0o700);
    const preload = join(directory, "preload.cjs");
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},process.env.OP_SERVICE_ACCOUNT_TOKEN??'preloaded');throw Error('preload')`,
    );
    env.PATH = `:.:relative:${directory}:${env.PATH}`;
    env.NODE_OPTIONS = `--require=${preload}`;
    env.OP_SERVICE_ACCOUNT_TOKEN = TOKEN;
    expect((await cli(["inventory"], undefined, directory)).code).toBe(0);
    expect((await calls()).length).toBeGreaterThan(0);
    await expect(readFile(marker)).rejects.toThrow();
    expect((await cli(["doctor"], undefined, directory)).code).toBe(0);
    await expect(readFile(marker)).rejects.toThrow();
  });
  it("request and lease reject invalid authority and noninteractive approval before provider access", async () => {
    const { cli, calls } = fixture;
    const binding = [
      "https://example.com/private?token=URLCANARY",
      "--secret",
      "op://Automation/Database/password",
    ];
    const missing = await cli(["request", ...binding]);
    expect(missing.code).toBe(2);
    expect(
      (await cli(["request", ...binding, "--lease", "missing"])).code,
    ).toBe(1);
    const denied = await cli(["lease", "approve", ...binding]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("interactive terminal");
    expect(
      (await cli(["lease", "approve", ...binding, "--uses", "11"])).code,
    ).toBe(1);
    expect(
      (await cli(["lease", "approve", ...binding, "--expires-in", "2h"])).code,
    ).toBe(1);
    expect((await cli(["lease", "status", "missing"])).code).toBe(1);
    expect((await cli(["lease", "revoke", "missing"])).code).toBe(1);
    expect(await calls()).toHaveLength(0);
  });
  it("interactive lease approval uses desktop metadata and status revoke exact binding fail closed", async () => {
    const { cli, calls } = fixture;
    const stdout = await approve(
      fixture,
      "https://127.0.0.1/private?token=URLCANARY",
    );
    expect(stdout).toContain(
      '"url":"https://127.0.0.1/private?token=URLCANARY"',
    );
    expect(stdout).toContain('"header":"Authorization"');
    expect(stdout).toContain('"prefix":"Bearer "');
    const publicReceipt = JSON.parse(stdout.slice(stdout.indexOf("\n{") + 1));
    expect(JSON.stringify(publicReceipt)).not.toContain("URLCANARY");
    expect(publicReceipt.destination).toBe("https://127.0.0.1");
    expect((await calls()).map((call) => call.args.slice(0, 2))).toEqual([
      ["item", "list"],
    ]);
    expect((await calls())[0].token).toBeUndefined();
    const id = /"id": "([a-f0-9-]{36})"/.exec(stdout)?.[1];
    expect(id).toBeDefined();
    const identifier = id ?? "missing";
    const status = JSON.parse(
      (await cli(["lease", "status", identifier])).stdout,
    );
    expect(status.itemVersion).toBe(7);
    expect(status.usesRemaining).toBe(1);
    const count = (await calls()).length;
    expect(
      (
        await cli([
          "request",
          "https://127.0.0.1/private?token=DIFFERENT",
          "--secret",
          "op://Automation/Database/password",
          "--lease",
          identifier,
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await cli([
          "request",
          "https://127.0.0.1/private?token=URLCANARY",
          "--secret",
          "op://Automation/Database/password",
          "--lease",
          identifier,
        ])
      ).code,
    ).toBe(1);
    expect(await calls()).toHaveLength(count);
    expect(
      JSON.parse((await cli(["lease", "status", identifier])).stdout)
        .usesRemaining,
    ).toBe(1);
    expect(
      JSON.parse((await cli(["lease", "revoke", identifier])).stdout).revoked,
    ).toBe(true);
  });
  it("native request deadline kills a stuck private read and burns its atomic lease without retry", async () => {
    const { cli, calls, directory } = fixture;
    const destination = "https://8.8.8.8/private?token=URLCANARY";
    const approval = await approve(fixture, destination);
    const identifier =
      /"id": "([a-f0-9-]{36})"/.exec(approval)?.[1] ?? "missing";
    expect(identifier).not.toBe("missing");
    const helper = join(directory, "bin", "op");
    const source = await readFile(helper, "utf8");
    await writeFile(
      helper,
      source.replace(
        "if (process.env.PARITY_STUCK_VERSION",
        `if (args[0] === "read") { fs.writeFileSync(${JSON.stringify(join(directory, "read.pid"))}, String(process.pid)); setInterval(() => {}, 1000); } else if (process.env.PARITY_STUCK_VERSION`,
      ),
    );
    const args = [
      "request",
      destination,
      "--secret",
      "op://Automation/Database/password",
      "--lease",
      identifier,
    ];
    const started = Date.now();
    const result = await cli(args);
    expect(result.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(19_000);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("deadline");
    const helperPid = Number(
      await readFile(join(directory, "read.pid"), "utf8"),
    );
    expect(() => process.kill(helperPid, 0)).toThrow();
    expect(
      (await calls()).filter((call) => call.args[0] === "read"),
    ).toHaveLength(1);
    expect(
      JSON.parse((await cli(["lease", "status", identifier])).stdout)
        .usesRemaining,
    ).toBe(0);
    const count = (await calls()).length;
    expect((await cli(args)).code).toBe(1);
    expect(await calls()).toHaveLength(count);
  });
});

async function approve(fixture: Fixture, destination: string): Promise<string> {
  const { env, database } = fixture;
  const data = JSON.parse(await readFile(database, "utf8"));
  data.items[0].version = 7;
  await writeFile(database, JSON.stringify(data));
  env.OP_SERVICE_ACCOUNT_TOKEN = TOKEN;
  const binary =
    process.env.OPENSESAME_NATIVE_BINARY ??
    resolve(
      process.env.CARGO_TARGET_DIR ??
        resolve(process.env.HOME ?? "", ".cache/packages/cargo-target"),
      "debug/opensesame",
    );
  const args = [
    binary,
    "password-agent",
    "lease",
    "approve",
    destination,
    "--secret",
    "op://Automation/Database/password",
  ];
  const command = args
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const { stdout, stderr } = await promisify(execFile)(
    "/usr/bin/script",
    ["-q", "-e", "-c", command, "/dev/null"],
    { env },
  );
  return stdout + stderr;
}
