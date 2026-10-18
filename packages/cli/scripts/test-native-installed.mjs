/** Installed Node bundle plus actual built native companion, through public human commands. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const executable = process.env.OPENSESAME_NATIVE_TEST_BINARY;
if (!executable)
  throw new Error(
    "OPENSESAME_NATIVE_TEST_BINARY must identify the actual built native companion.",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = await mkdtemp(join(tmpdir(), "opensesame-native-installed-"));
try {
  await cp(join(root, "dist"), join(stage, "dist"), { recursive: true });
  await writeFile(join(stage, "package.json"), '{"type":"module"}\n');
  const native = join(
    stage,
    "dist/native",
    `${process.platform}-${process.arch}`,
  );
  await mkdir(native, { recursive: true });
  const name = process.platform === "win32" ? "opensesame.exe" : "opensesame";
  await cp(executable, join(native, name));
  await chmod(join(native, name), 0o755);
  const { runCli } = await import(
    pathToFileURL(join(stage, "dist/index.js")).href
  );
  const stateDir = join(stage, "state");
  const owner = "current owner password for installed command controls";
  const retired = "retired password for installed command controls";
  async function run(args, answers) {
    let out = "";
    let err = "";
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    process.stdout.write = (value) => {
      out += String(value);
      return true;
    };
    process.stderr.write = (value) => {
      err += String(value);
      return true;
    };
    try {
      const code = await runCli(args, {
        stateDir,
        readPassword: async () => {
          const value = answers.shift();
          if (value === undefined)
            throw new Error("Unexpected terminal prompt.");
          return value;
        },
      });
      return { code, out, err };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  }
  const created = await run(
    ["vault", "new", "secret", "--name", "Real owner item"],
    [owner, owner, "real-secret-canary-value"],
  );
  assert.equal(created.code, 0, created.err);
  const enrolled = await run(
    ["vault", "retired", "enroll", "--response", "reject"],
    [owner, retired, retired],
  );
  assert.equal(enrolled.code, 0, enrolled.err);
  assert.equal(JSON.parse(enrolled.out).traps.length, 1);
  const rejected = await run(["vault", "list"], [retired]);
  assert.equal(rejected.code, 1, rejected.out);
  assert.doesNotMatch(
    rejected.out + rejected.err,
    /Real owner item|real-secret-canary-value/,
  );
  const inspected = await run(["vault", "retired", "inspect"], [owner]);
  assert.equal(inspected.code, 0, inspected.err);
  assert.ok(
    JSON.parse(inspected.out).events.some(
      (event) => event.type === "retired_credential_observed",
    ),
  );
  const real = await run(["vault", "list"], [owner]);
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /Real owner item/);
  const decoy = "synthetic retired password for installed command controls";
  const decoyEnrolled = await run(
    ["vault", "retired", "enroll", "--response", "synthetic_decoy"],
    [owner, decoy, decoy],
  );
  assert.equal(decoyEnrolled.code, 0, decoyEnrolled.err);
  const synthetic = await run(["vault", "list"], [decoy]);
  assert.equal(synthetic.code, 0, synthetic.err);
  assert.doesNotMatch(
    synthetic.out + synthetic.err,
    /Real owner item|real-secret-canary-value/,
  );
  const syntheticExport = await run(
    ["vault", "export", "--out", join(stage, "synthetic-export.json")],
    [decoy],
  );
  assert.equal(syntheticExport.code, 1, syntheticExport.out);
  assert.doesNotMatch(
    syntheticExport.out + syntheticExport.err,
    /Real owner item|real-secret-canary-value/,
  );
  const realAfter = await run(["vault", "list"], [owner]);
  assert.equal(realAfter.code, 0, realAfter.err);
  assert.match(realAfter.out, /Real owner item/);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const endpoint = `http://127.0.0.1:${port}`;
  const receiver = [
    "--receiver",
    endpoint,
    "--service-id",
    "a".repeat(64),
    "--origin",
    "https://vault.example",
    "--port",
    String(port),
  ];
  const pairing = join(stage, "pairing.json");
  const paired = await run(
    ["vault", "canary", "pairing", ...receiver, "--out", pairing],
    [owner],
  );
  assert.equal(paired.code, 0, paired.err);
  const service = spawn(
    process.execPath,
    [
      join(stage, "dist/bin.js"),
      "security",
      "canary",
      "serve",
      "--pairing",
      pairing,
      "--state",
      join(stage, "receiver"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let serviceError = "";
  service.stderr.on("data", (value) => {
    serviceError += String(value);
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (service.exitCode !== null) throw new Error(serviceError);
      try {
        await fetch(endpoint);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(ready, "Controlled receiver did not start.");
    const enrolledCanary = await run(
      [
        "vault",
        "canary",
        "enroll",
        ...receiver,
        "--label",
        "Installed canary",
        "--artifact-kind",
        "mcp-config",
        "--owner-consent",
      ],
      [owner],
    );
    assert.equal(enrolledCanary.code, 0, enrolledCanary.err);
    const canaryId = JSON.parse(enrolledCanary.out).record.id;
    const inspectedCanary = await run(
      ["vault", "canary", "inspect", ...receiver],
      [owner],
    );
    assert.equal(inspectedCanary.code, 0, inspectedCanary.err);
    assert.equal(JSON.parse(inspectedCanary.out).records.length, 1);
    const exportedCanary = await run(
      [
        "vault",
        "canary",
        "export",
        canaryId,
        ...receiver,
        "--out",
        join(stage, "canary-config.json"),
      ],
      [owner],
    );
    assert.equal(exportedCanary.code, 0, exportedCanary.err);
    const removedCanary = await run(
      ["vault", "canary", "remove", canaryId, ...receiver],
      [owner],
    );
    assert.equal(removedCanary.code, 0, removedCanary.err);
  } finally {
    service.kill("SIGTERM");
    await new Promise((resolve) => service.once("exit", resolve));
  }
  process.stdout.write(
    "Installed native CLI: create, fresh owner enrollment, retired rejection/event, synthetic isolation/export denial, current login, paired canary enrollment/inspection/export/removal passed.\n",
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
