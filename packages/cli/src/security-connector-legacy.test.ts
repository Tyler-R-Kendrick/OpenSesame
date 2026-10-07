import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeviceSecrets } from "@opensesame/app-core/lib/device-connector-records.js";
import { kvSetDurable } from "@opensesame/app-core/lib/kv.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCli } from "./run.js";
import { releaseVaultKv } from "./vault-kv.js";
import { openLocalVault, unlockLocalVault } from "./vault-session.js";

const PASSWORD = "Actual legacy connector CLI owner password";
const FIXTURE_SECRET = "public-fixture-legacy-connector-key";
let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "os-cli-connector-migration-"));
  const store = await openLocalVault(directory);
  await store.create(PASSWORD);
  await store.flushPendingWrites();
  await kvSetDurable(
    "opensesame.device-connectors.v1",
    JSON.stringify([
      {
        connectionId: "device_legacy",
        providerId: "anthropic",
        displayName: "Legacy fixture",
        scopes: [],
        fields: {},
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      },
    ]),
  );
  await kvSetDurable(
    "opensesame.device-connector-secrets.v1",
    JSON.stringify({
      device_legacy: { credential: FIXTURE_SECRET },
    }),
  );
  await releaseVaultKv();
});
afterEach(async () => {
  await releaseVaultKv();
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], password = PASSWORD) {
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
      code: await runCli(["security", "connectors", ...args, "--json"], {
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

it("reviews persisted legacy metadata and imports it under the genuine owner's root", async () => {
  const status = await run(["legacy-status"]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.out)).toMatchObject({
    pending: true,
    records: [{ connectionId: "device_legacy" }],
  });
  expect(status.out).not.toContain(FIXTURE_SECRET);
  const imported = await run([
    "legacy-import",
    "device_legacy",
    "--acknowledge-ownership-ambiguity",
  ]);
  expect(imported.code).toBe(0);
  expect(JSON.parse(imported.out)).toMatchObject({ pending: false });
  expect(imported.out + imported.err).not.toContain(FIXTURE_SECRET);
  expect(imported.out + imported.err).not.toContain(PASSWORD);
  const store = await openLocalVault(directory);
  await unlockLocalVault(store, PASSWORD);
  expect(readDeviceSecrets().device_legacy?.credential).toBe(FIXTURE_SECRET);
});

it("refuses wrong current proof without discarding records, then permits an explicit owner discard", async () => {
  const denied = await run(
    ["legacy-discard", "device_legacy", "--acknowledge-ownership-ambiguity"],
    "incorrect-fixture-password",
  );
  expect(denied.code).not.toBe(0);
  const preserved = await run(["legacy-status"]);
  expect(JSON.parse(preserved.out)).toMatchObject({ pending: true });
  const discarded = await run([
    "legacy-discard",
    "device_legacy",
    "--acknowledge-ownership-ambiguity",
  ]);
  expect(discarded.code).toBe(0);
  expect(JSON.parse(discarded.out)).toMatchObject({
    pending: false,
    records: [],
  });
});

it("recovers a malformed legacy map only after the deliberate discard-all ceremony", async () => {
  const store = await openLocalVault(directory);
  await unlockLocalVault(store, PASSWORD);
  await kvSetDurable(
    "opensesame.device-connector-secrets.v1",
    "malformed legacy fixture",
  );
  await releaseVaultKv();
  const denied = await run(
    ["legacy-discard-all", "--acknowledge-irrecoverable-legacy-discard"],
    "incorrect-fixture-password",
  );
  expect(denied.code).not.toBe(0);
  const recovered = await run([
    "legacy-discard-all",
    "--acknowledge-irrecoverable-legacy-discard",
  ]);
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.out)).toMatchObject({
    pending: false,
    records: [],
  });
  expect(recovered.out + recovered.err).not.toContain(PASSWORD);
});
