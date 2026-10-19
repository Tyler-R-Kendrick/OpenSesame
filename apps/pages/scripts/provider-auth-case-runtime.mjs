/** Owned serial provider cases and bounded, nonsecret monotonic stage receipts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startOpenBao } from "../../../scripts/test/provider-auth-services.mjs";
import { providerAuthVaultFixture } from "../../../scripts/test/provider-auth-vault-fixture.mjs";

/** Cleanup every owner, including when another close throws synchronously. */
export async function closeProviderAuthResources(resources, primaryError) {
  const settled = await Promise.allSettled(
    resources
      .filter(Boolean)
      .map((resource) => Promise.resolve().then(() => resource.close())),
  );
  const failures = [];
  for (const result of settled)
    if (result.status === "rejected") failures.push(result.reason);
  if (!failures.length) return;
  if (primaryError !== undefined) failures.unshift(primaryError);
  throw new AggregateError(failures, "Provider verification cleanup failed.");
}

function providerBinaries(root, out) {
  const fixtures = path.join(out, "fixtures");
  const openbao = execFileSync(
    "bash",
    [path.join(root, "scripts/mtls/mtls-fixtures.sh"), "path", "openbao"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, OPENSESAME_MTLS_FIXTURE_DIR: fixtures },
    },
  ).trim();
  return { openbao, vault: providerAuthVaultFixture(fixtures) };
}

async function openCase(root, out, label, binaries, resources, providers) {
  const openbao = await providers.start({
    root,
    out: path.join(out, label, "openbao"),
    providerBinary: binaries.openbao,
  });
  resources.push(openbao);
  const vault = await providers.start({
    root,
    out: path.join(out, label, "vault"),
    providerBinary: binaries.vault,
    providerName: "HashiCorp Vault 1.21.4",
  });
  resources.push(vault);
  return { label, services: { vault, openbao } };
}

/** A pair exists only for its own case; this prerequisite admits one at a time. */
export function providerAuthCases({
  root,
  out,
  phases,
  providers = { load: providerBinaries, start: startOpenBao },
}) {
  const used = new Set();
  const active = new Set();
  let binaries;
  async function run(label, work) {
    assert.ok(["desktop", "phone"].includes(label), "Known provider width");
    assert.ok(!used.has(label), "Each provider width runs exactly once");
    assert.equal(active.size, 0, "Provider cases are serial at this stage");
    used.add(label);
    active.add(label);
    const resources = [];
    let primaryError;
    try {
      binaries ??= await phases.run("fixture-binaries", () =>
        providers.load(root, out),
      );
      const owned = await phases.run(`fixtures-${label}`, () =>
        openCase(root, out, label, binaries, resources, providers),
      );
      return await work(owned);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await closeProviderAuthResources(resources, primaryError);
      } finally {
        active.delete(label);
      }
    }
  }
  return { run };
}

/** Retain only the original fixture's CA/key for the shared static site/issuer. */
export function retainProviderAuthTls(out, original) {
  const directory = fs.mkdtempSync(path.join(out, "site-tls-"));
  try {
    for (const name of ["vault-key.pem", "vault-cert.pem", "vault-ca.pem"])
      fs.writeFileSync(
        path.join(directory, name),
        fs.readFileSync(path.join(original, name)),
        { flag: "wx", mode: 0o600 },
      );
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    async close() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function writePhases(file, rows) {
  const current = fs.lstatSync(file);
  assert.ok(
    current.isFile() && !current.isSymbolicLink() && current.nlink === 1,
  );
  const text = `${JSON.stringify({ clock: "monotonic", stages: rows }, null, 2)}\n`;
  assert.ok(Buffer.byteLength(text) <= 16384, "Bounded provider stage receipt");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Does not change any operation's timeout; failed stages retain only timings. */
export function providerAuthPhases(out) {
  const file = path.join(out, "phase-timings.json");
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.closeSync(descriptor);
  const epoch = performance.now();
  const rows = [];
  const names = new Set();
  writePhases(file, rows);
  async function run(name, work) {
    assert.match(name, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(!names.has(name), "Each provider stage is measured once");
    assert.ok(rows.length < 32, "At most 32 provider stages");
    names.add(name);
    const started = performance.now();
    const row = { name, startMs: started - epoch, status: "running" };
    rows.push(row);
    writePhases(file, rows);
    let primaryError;
    let result;
    let failed = false;
    try {
      result = await work();
      row.status = "passed";
    } catch (error) {
      row.status = "failed";
      primaryError = error;
      failed = true;
    }
    row.durationMs = performance.now() - started;
    try {
      writePhases(file, rows);
      process.stdout.write(
        `${JSON.stringify({ providerAuthStage: row.name, status: row.status, durationMs: Math.round(row.durationMs) })}\n`,
      );
    } catch (error) {
      if (failed)
        throw new AggregateError(
          [primaryError, error],
          "Provider stage receipt failed.",
        );
      throw error;
    }
    if (failed) throw primaryError;
    return result;
  }
  return { file, run };
}
