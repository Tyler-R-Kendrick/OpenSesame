import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listControlledCanaries,
  listInstalledControlledValidatorEvents,
} from "@opensesame/app-core/lib/credential-canaries/index.js";
import { kvFileName } from "@opensesame/app-core/lib/kv.js";
import { tombStorageKeys } from "@opensesame/app-core/lib/vault/tomb-migration.js";
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseCanaryConfiguration } from "./canary-config.js";
import { controlledDetectorStorage } from "./canary-detector.js";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault, unlockLocalVault } from "./vault-session.js";
const PASSWORD = "correct horse battery staple";
let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "os-human-canary-"));
  const store = await openLocalVault(directory);
  await store.create(PASSWORD);
  await store.addItems([createItem("note", "Real owner private item")]);
  await store.flushPendingWrites();
  await releaseVaultKv();
});
afterEach(async () => {
  await releaseVaultKv();
  await rm(directory, { recursive: true, force: true });
});
async function run(argv: string[], password = PASSWORD) {
  let out = "";
  let err = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((value) => {
      out += String(value);
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((value) => {
      err += String(value);
      return true;
    });
  try {
    return {
      code: await runCli(argv, {
        stateDir: directory,
        readPassword: async () => password,
      }),
      out,
      err,
    };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
async function validator(file: string, lines: string, stateDir = directory) {
  const input = join(directory, "requests.jsonl");
  const output = join(directory, "responses.jsonl");
  const errors = join(directory, "errors.txt");
  await writeFile(input, lines, { mode: 0o600 });
  const handles = await Promise.all([
    open(input, "r"),
    open(output, "w", 0o600),
    open(errors, "w", 0o600),
  ]);
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "canary", "serve", "--config", file],
      {
        env: { ...process.env, OPENSESAME_STATE_DIR: stateDir },
        stdio: handles.map((handle) => handle.fd),
      },
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return {
      code,
      out: await readFile(output, "utf8"),
      err: await readFile(errors, "utf8"),
    };
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}
it("exports once without printing identifiers, and an actual locked stdio process records only controlled metadata", async () => {
  const file = join(directory, "canary.json");
  const created = await run([
    "security",
    "canary",
    "export-mcp",
    "--output",
    file,
    "--json",
  ]);
  expect({ code: created.code, err: created.err }).toEqual({
    code: 0,
    err: "",
  });
  const config = z
    .object({
      artifact: z.object({ id: z.string(), presentedId: z.string() }),
      mcpServers: z.object({
        OpenSesameCanary: z.object({
          command: z.literal("opensesame-id"),
          args: z.array(z.string()),
        }),
      }),
    })
    .parse(JSON.parse(await readFile(file, "utf8")));
  expect(created.out).not.toContain(config.artifact.presentedId);
  expect(config.mcpServers.OpenSesameCanary.args).toEqual([
    "canary",
    "serve",
    "--config",
    file,
  ]);
  const child = await validator(
    file,
    `${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "canary.status", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "vault.export", arguments: {} },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`,
  );
  expect(child.code).toBe(0);
  expect(child.out).toContain("canary.status");
  expect(child.out).toContain("Canary request rejected.");
  expect(child.out + child.err).not.toContain(config.artifact.presentedId);
  expect(child.out + child.err).not.toContain("Real owner private item");
  const owner = await openLocalVault(directory);
  await unlockLocalVault(owner, PASSWORD);
  const status = await listControlledCanaries(owner.activeTomb());
  const installed = parseCanaryConfiguration(await readFile(file, "utf8"));
  if (!installed.validatorBinding)
    throw new Error("Expected installed detector binding");
  const events = await listInstalledControlledValidatorEvents(
    installed.validatorBinding,
    controlledDetectorStorage(installed.validatorBinding),
  );
  expect(events.map((event) => event.phase)).toEqual(
    expect.arrayContaining(["connected", "invoked"]),
  );
  expect(status.events.map((event) => event.phase)).toContain(
    "artifact_dispatched",
  );
  expect(JSON.stringify(status)).not.toContain(config.artifact.presentedId);
  expect(owner.getSnapshot().items.map((item) => item.name)).toContain(
    "Real owner private item",
  );
}, 60000);
it("refuses an oversized final MCP export before creating a file or retaining its artifact", async () => {
  const file = join(
    directory,
    ...Array.from({ length: 20 }, () => "nested-owner-directory".repeat(9)),
    "canary.json",
  );
  const result = await run([
    "security",
    "canary",
    "export-mcp",
    "--output",
    file,
  ]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Canary configuration exceeds 4 KiB.");
  const store = await openLocalVault(directory);
  await unlockLocalVault(store, PASSWORD);
  expect((await listControlledCanaries(store.activeTomb())).artifacts).toEqual(
    [],
  );
  expect(store.getSnapshot().items.map((item) => item.name)).toContain(
    "Real owner private item",
  );
});
it("rejects oversized real-process requests and revoked configuration without admitting production tools", async () => {
  const file = join(directory, "canary.json");
  expect(
    (await run(["security", "canary", "export-mcp", "--output", file])).code,
  ).toBe(0);
  const oversized = await validator(file, `${"x".repeat(4097)}\n`);
  expect(oversized.code).toBe(1);
  expect(oversized.err).toContain("4 KiB");
  const config = z
    .object({ artifact: z.object({ id: z.string() }) })
    .parse(JSON.parse(await readFile(file, "utf8")));
  expect(
    (await run(["security", "canary", "remove", config.artifact.id])).code,
  ).toBe(0);
  expect((await run(["canary", "uninstall", "--config", file])).code).toBe(0);
  const revoked = await validator(
    file,
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
  );
  expect(revoked.out).toContain("Canary request rejected.");
  expect(revoked.out).not.toContain("serverInfo");
}, 60000);
it("requires fresh owner authentication and never overwrites an existing secret file", async () => {
  const file = join(directory, "canary.json");
  expect(
    (
      await run(
        ["security", "canary", "export-mcp", "--output", file],
        "wrong owner password",
      )
    ).code,
  ).toBe(1);
  expect(
    (await run(["security", "canary", "export-mcp", "--output", file])).code,
  ).toBe(0);
  const original = await readFile(file, "utf8");
  expect(
    (await run(["security", "canary", "export-mcp", "--output", file])).code,
  ).toBe(1);
  expect(await readFile(file, "utf8")).toBe(original);
  const owner = await openLocalVault(directory);
  await unlockLocalVault(owner, PASSWORD);
  expect(
    (await listControlledCanaries(owner.activeTomb())).artifacts,
  ).toHaveLength(1);
}, 60000);

it("installs an owner export in a separate empty CLI environment without copying real vault material", async () => {
  const file = join(directory, "portable-canary.json");
  expect(
    (await run(["security", "canary", "export-mcp", "--output", file])).code,
  ).toBe(0);
  const empty = join(directory, "empty-validator");
  let out = "";
  const stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((value) => {
      out += String(value);
      return true;
    });
  try {
    expect(
      await runCli(
        ["canary", "install", "--config", file, "--trust-configuration"],
        {
          stateDir: empty,
          readPassword: async () => {
            throw new Error(
              "Detector installation must not acquire an owner root.",
            );
          },
        },
      ),
    ).toBe(0);
  } finally {
    stdout.mockRestore();
  }
  const child = await validator(
    file,
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "canary.status", arguments: {} } })}\n`,
    empty,
  );
  expect(child.code).toBe(0);
  expect(child.out).toContain("serverInfo");
  expect(child.out).not.toContain("Real owner private item");
  expect(out).toContain("Installed a local synthetic detector");
  const config = parseCanaryConfiguration(await readFile(file, "utf8"));
  expect(child.out + child.err + out).not.toContain(
    config.artifact.presentedId,
  );
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(empty, "origin-files"));
  if (!config.validatorBinding)
    throw new Error("Expected installed detector binding");
  expect(files).toContain(
    kvFileName(
      `credential-canary-validator.v1.${config.validatorBinding.validatorId}`,
    ),
  );
  for (const key of tombStorageKeys("personal"))
    expect(files).not.toContain(kvFileName(key));
}, 60000);

it("rolls back a genuine artifact when the fitting server branch expands beyond the final export bound", async () => {
  const { assertCanaryExportOutputFits } = await import(
    "./canary-export-template.js"
  );
  const file = join(
    directory,
    ...Array.from({ length: 17 }, () => "nested-owner-directory".repeat(9)),
    "canary.json",
  );
  expect(() => assertCanaryExportOutputFits(file)).not.toThrow();
  const result = await run([
    "security",
    "canary",
    "export-mcp",
    "--output",
    file,
  ]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Canary configuration exceeds 4 KiB.");
  await expect(readFile(file, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  const store = await openLocalVault(directory);
  await unlockLocalVault(store, PASSWORD);
  expect((await listControlledCanaries(store.activeTomb())).artifacts).toEqual(
    [],
  );
  expect(store.getSnapshot().items.map((item) => item.name)).toContain(
    "Real owner private item",
  );
}, 60000);
