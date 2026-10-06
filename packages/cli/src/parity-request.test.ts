import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { createLease } from "@opensesame/app-core/lib/password-agent/lease.js";
import { describeRequest } from "@opensesame/app-core/lib/password-agent/request.js";
import { afterEach, describe, expect, it } from "vitest";
import { approvalTerminal } from "./fixtures/password-agent/approval-terminal.js";
import { processFixture } from "./fixtures/password-agent/process.js";
import { openLeaseStore } from "./parity-lease-node.js";
import {
  helperEnvironment,
  invokeOp,
  resolveCredentialHelper,
} from "./parity-node.js";
const directories: string[] = [];
afterEach(async () => {
  Reflect.deleteProperty(process.env, "OPENSESAME_STATE_DIR");
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("private request and authority CLI", { timeout: 60000 }, () => {
  it("rejects unsafe request destinations and noninteractive approval before helper access", async () => {
    const fixture = await processFixture();
    directories.push(fixture.directory);
    const denied = await fixture.cli([
      "request",
      "https://127.0.0.1/private",
      "--secret",
      "op://Automation/Database/password",
      "--lease",
      "missing",
    ]);
    expect(denied.code).toBe(1);
    expect(denied.stdout).not.toContain("original");
    const approval = await fixture.cli([
      "lease",
      "approve",
      "https://example.com",
      "--secret",
      "op://Automation/Database/password",
      "--desktop",
    ]);
    expect(approval.code).toBe(1);
    expect(approval.stderr).toContain("interactive");
    expect(
      await readFile(join(fixture.directory, "calls.jsonl"), "utf8").catch(
        () => "",
      ),
    ).toBe("");
  });
  it("durably atomically claims exactly one use and preserves authority-only metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lease-authority-"));
    directories.push(directory);
    process.env.OPENSESAME_STATE_DIR = directory;
    const first = await openLeaseStore();
    const second = await openLeaseStore();
    try {
      const binding = describeRequest({
        url: "https://example.com/a?private=query",
        reference: "op://Automation/Database/password",
      });
      const resource = { id: "a".repeat(26), version: 1 };
      const principal = await first.principal();
      const grant = createLease({
        id: "grant",
        principal,
        binding,
        resource,
        now: 1000,
      });
      await first.insert(grant);
      const results = await Promise.allSettled([
        first.claim("grant", binding, resource, principal, 1001),
        second.claim("grant", binding, resource, principal, 1001),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await second.get("grant")).usesRemaining).toBe(0);
      expect(JSON.stringify(await second.list())).not.toContain(
        "private=query",
      );
      await expect(
        second.claim("grant", binding, resource, principal, 1002),
      ).rejects.toThrow();
      expect((await second.revoke("grant", principal, 1003)).revoked).toBe(
        true,
      );
    } finally {
      first.close();
      second.close();
    }
    const reopened = await openLeaseStore();
    try {
      expect((await reopened.get("grant")).usesRemaining).toBe(0);
    } finally {
      reopened.close();
    }
  });
  it("starts the real helper in controlled cwd without inherited Node preloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "helper-startup-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    await mkdir(bin);
    const marker = join(directory, "preloaded");
    const preload = join(directory, "preload.cjs");
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
    );
    await writeFile(
      join(bin, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeSync(1,JSON.stringify({cwd:process.cwd(),preload:process.env.NODE_OPTIONS??null}));`,
    );
    await chmod(join(bin, "op"), 0o700);
    const original = process.env.PATH;
    const originalCwd = process.cwd();
    const planted = join(directory, "planted-marker");
    await writeFile(
      join(directory, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(planted)},'ran');`,
    );
    await chmod(join(directory, "op"), 0o700);
    try {
      process.chdir(directory);
      process.env.PATH = `${directory}:.:relative:${bin}`;
      const output = await invokeOp(["--version"], {
        env: { NODE_OPTIONS: `--require ${preload}`, NODE_PATH: directory },
      });
      expect(JSON.parse(output)).toEqual({
        cwd: parse(process.execPath).root,
        preload: null,
      });
      await expect(readFile(marker)).rejects.toThrow();
      await expect(readFile(planted)).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = original;
    }
  });
  it("isolates credential-helper startup before interpreter preloads and ignores relative PATH entries", () => {
    const env = helperEnvironment({
      PATH: `.:relative:${process.execPath}`,
      NODE_OPTIONS: "--require attacker.cjs",
      NODE_PATH: ".",
      OP_SERVICE_ACCOUNT_TOKEN: "ops_canary",
      BASH_ENV: "evil",
      LD_PRELOAD: "evil",
    });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_canary");
    const original = process.env.PATH;
    try {
      process.env.PATH = `:.:relative:${process.cwd()}`;
      expect(() => resolveCredentialHelper("op")).toThrow();
    } finally {
      process.env.PATH = original;
    }
  });
});

it("real concurrent processes atomically consume the SQLite budget once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lease-race-"));
  directories.push(directory);
  process.env.OPENSESAME_STATE_DIR = directory;
  const store = await openLeaseStore();
  try {
    await store.insert(
      createLease({
        id: "race",
        principal: await store.principal(),
        binding: describeRequest({
          url: "https://example.com/race",
          reference: "op://Automation/Database/password",
        }),
        resource: { id: "a".repeat(26), version: 1 },
        now: Date.now(),
      }),
    );
  } finally {
    store.close();
  }
  const race = () =>
    new Promise<string>((finish, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("src/fixtures/password-agent/lease-claim.ts"),
        ],
        { env: process.env, stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? finish(output) : reject(new Error("Claim process failed")),
      );
    });
  const results = await Promise.all([race(), race(), race(), race()]);
  expect(results.filter((output) => JSON.parse(output).claimed)).toHaveLength(
    1,
  );
  const final = await openLeaseStore();
  try {
    expect((await final.get("race")).usesRemaining).toBe(0);
  } finally {
    final.close();
  }
}, 60000);

it("real human terminal approval uses desktop metadata only and persists a verified grant", async () => {
  const fixture = await processFixture();
  directories.push(fixture.directory);
  fixture.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_service-canary";
  expect((await approvalTerminal(fixture.env)).code).toBe(0);
  const calls = await fixture.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args.slice(0, 2)).toEqual(["item", "list"]);
  expect(calls[0]?.token).toBeUndefined();
  expect(calls[0]?.args.slice(-2)).toEqual(["--account", "selected.account"]);
  process.env.OPENSESAME_STATE_DIR = fixture.env.OPENSESAME_STATE_DIR;
  const store = await openLeaseStore();
  try {
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      itemVersion: 1,
      useBudget: 1,
      usesRemaining: 1,
      destination: "https://request.example",
      revoked: false,
    });
  } finally {
    store.close();
  }
}, 60000);

it("actual human approval terminal escapes control bytes in destination and credential reference", async () => {
  const fixture = await processFixture();
  directories.push(fixture.directory);
  const url = "https://request.example/\u001b[2Jspoofed";
  const reference = "op://Automation/Database/\u001b[2Jpassword";
  const result = await approvalTerminal(fixture.env, url, reference);
  expect(result.code).toBe(0);
  expect(result.output).toContain(JSON.stringify(url));
  expect(result.output).toContain(JSON.stringify(reference));
  // Readline may emit its own cursor controls on a capable CI terminal.
  // The attacker-provided erase-screen control must never reach the terminal.
  expect(result.output).not.toContain("\u001b[2J");
  const calls = await fixture.calls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args.slice(0, 2)).toEqual(["item", "list"]);
}, 60000);
