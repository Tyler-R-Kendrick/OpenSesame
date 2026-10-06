import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createNodeHost } from "../node/host.js";
import { requireDeviceConnectorPrincipal } from "./device-connector-principal.js";
import { readDeviceRows } from "./device-connector-records.js";
import { createDeviceConnection } from "./device-connectors.js";
import { kvFlush, kvForgetAll, kvGet, kvRefresh } from "./kv.js";
import { vaultStore } from "./vault/store.js";
const PASSWORD = "actual-concurrent-metadata-owner-password";
function child(fixture: string, directory: string, name: string) {
  const processHandle = spawn(
    process.execPath,
    [fixture, directory, PASSWORD, name],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  const ready = new Promise<void>((resolve, reject) => {
    processHandle.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.startsWith("ready\n")) resolve();
    });
    processHandle.once("error", reject);
    processHandle.once("exit", () => {
      if (!output.startsWith("ready\n"))
        reject(
          new Error(
            `Child readiness failed; stdout=${output}; stderr=${errors}`,
          ),
        );
    });
  });
  const completed = new Promise<{ code: number | null; errors: string }>(
    (resolve) => {
      processHandle.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      processHandle.once("error", (error) =>
        resolve({ code: -1, errors: error.message }),
      );
      processHandle.once("exit", (code) => resolve({ code, errors }));
    },
  );
  return { processHandle, ready, completed };
}
it("two independent authenticated processes preserve both concurrent creations and another principal's quarantined metadata", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "connector-metadata-processes-"),
  );
  const fixture = join(directory, "metadata.mjs");
  configureHost(createNodeHost({ stateDir: directory }));
  vaultStore.loadActiveProjectScope();
  const running: ReturnType<typeof child>[] = [];
  try {
    await build({
      entryPoints: ["test-fixtures/device-connector-process.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: fixture,
      logLevel: "silent",
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });
    await vaultStore.create(PASSWORD);
    const original = await createDeviceConnection({
      providerId: "anthropic",
      displayName: "Original owner",
    });
    await kvFlush();
    vaultStore.lock();
    await vaultStore.createGuest({ resume: false });
    const guest = await createDeviceConnection({
      providerId: "azure-openai",
      displayName: "Another guest principal",
    });
    const guestOwner = requireDeviceConnectorPrincipal().id;
    vaultStore.lock();
    vaultStore.loadActiveProjectScope();
    running.push(
      child(fixture, directory, "First process"),
      child(fixture, directory, "Second process"),
    );
    await Promise.all(running.map((entry) => entry.ready));
    for (const entry of running) entry.processHandle.stdin.write("go\n");
    const outcomes = await Promise.all(running.map((entry) => entry.completed));
    for (const outcome of outcomes)
      expect(outcome.code, outcome.errors).toBe(0);
    await kvRefresh("opensesame.device-connectors.v1", 262144);
    const persisted = z
      .array(
        z.object({
          connectionId: z.string(),
          owner: z.string(),
        }),
      )
      .parse(JSON.parse(kvGet("opensesame.device-connectors.v1") ?? "[]"));
    expect(persisted).toContainEqual({
      connectionId: guest.connectionId,
      owner: guestOwner,
    });
    await vaultStore.unlock(PASSWORD);
    expect(
      readDeviceRows()
        .map((row) => row.displayName)
        .sort(),
    ).toEqual(["First process", "Original owner", "Second process"]);
    expect(
      readDeviceRows().some(
        (row) => row.connectionId === original.connectionId,
      ),
    ).toBe(true);
  } finally {
    for (const entry of running)
      if (entry.processHandle.exitCode === null)
        entry.processHandle.kill("SIGTERM");
    vaultStore.lock();
    await kvFlush();
    kvForgetAll();
    await rm(directory, { recursive: true, force: true });
  }
});
