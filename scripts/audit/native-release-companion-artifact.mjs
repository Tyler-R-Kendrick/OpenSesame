import { execFileSync, spawn } from "node:child_process";
// Actual default-release Cargo artifact provenance; no PATH executable or caller authority.
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
const MAX_BINARY = 256 * 1024 * 1024;
const audit = resolve(process.env.NATIVE_AUDIT_DIR ?? "");
const target = resolve(process.env.CARGO_TARGET_DIR ?? "");
const expected = process.env.EXPECTED_HEAD;
function refuse() {
  throw new Error("Original native release artifact is unavailable.");
}
function head() {
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!expected || !/^[a-f0-9]{40}$/.test(expected) || value !== expected)
    refuse();
  execFileSync("git", ["diff", "--exit-code"], { stdio: "pipe" });
  execFileSync("git", ["diff", "--cached", "--exit-code"], { stdio: "pipe" });
  return value;
}
function revision(value) {
  return [
    value.dev,
    value.ino,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
    value.mode,
  ]
    .map(String)
    .join(":");
}
async function boundedBytes(file, maximum) {
  const named = await lstat(file, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.size <= 0n ||
    named.size > BigInt(maximum)
  )
    refuse();
  const original = await open(file, "r");
  try {
    const before = await original.stat({ bigint: true });
    if (revision(named) !== revision(before)) refuse();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const next = await original.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (next.bytesRead < 1) refuse();
      offset += next.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await original.read(extra, 0, 1, offset)).bytesRead !== 0) refuse();
    const after = await original.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (
      revision(before) !== revision(after) ||
      revision(after) !== revision(current)
    )
      refuse();
    return { bytes, revision: revision(after) };
  } finally {
    await original.close();
  }
}
async function digest(file, maximum) {
  const original = await boundedBytes(file, maximum);
  return {
    sha256: createHash("sha256").update(original.bytes).digest("hex"),
    bytes: original.bytes.length,
    revision: original.revision,
  };
}
async function cargoArtifactRows() {
  const original = await boundedBytes(
    join(audit, "release-build.jsonl"),
    128 * 1024 * 1024,
  );
  return original.bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) refuse();
      return JSON.parse(line);
    });
}
async function runOriginal(executable, args, input) {
  const child = spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  const errors = [];
  let size = 0;
  let errorSize = 0;
  let failure;
  let timedOut = false;
  let forced;
  let stopping = false;
  const originalKill = child.kill;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // A timer never completes accepted child work. Escalate, then await actual close.
    forced = setTimeout(() => {
      try {
        originalKill.call(child, "SIGKILL");
      } catch (error) {
        failure ??= error;
      }
    }, 2000);
    try {
      originalKill.call(child);
    } catch (error) {
      failure ??= error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 30000);
  const record = (chunks, bytes, stderr) => {
    if (stderr) errorSize += bytes.length;
    else size += bytes.length;
    if (size > 65536 || errorSize > 65536) {
      failure ??= new Error("Original artifact output bound exceeded.");
      stop();
    } else chunks.push(new Uint8Array(bytes));
  };
  child.stdout.on("data", (bytes) => record(output, bytes, false));
  child.stderr.on("data", (bytes) => record(errors, bytes, true));
  child.stdin.on("error", (error) => {
    failure ??= error;
    stop();
  });
  child.stdout.on("error", (error) => {
    failure ??= error;
    stop();
  });
  child.stderr.on("error", (error) => {
    failure ??= error;
    stop();
  });
  const settled = new Promise((resolveClosed) => {
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  try {
    child.stdin.end(input);
    const { code, signal } = await settled;
    if (failure || timedOut || code !== 0 || signal)
      throw failure ?? new Error("Original native startup failed.");
    return { output: Buffer.concat(output), errors: Buffer.concat(errors) };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) stop();
    await settled;
    clearTimeout(forced);
  }
}
async function selectReleaseExecutable() {
  const manifest = await realpath("apps/cli/Cargo.toml");
  const main = await realpath("apps/cli/src/main.rs");
  const rows = await cargoArtifactRows();
  const candidates = rows.filter(
    (row) =>
      row.reason === "compiler-artifact" &&
      row.executable &&
      row.target?.name === "opensesame" &&
      row.target?.kind?.length === 1 &&
      row.target.kind[0] === "bin" &&
      row.profile?.test === false,
  );
  if (candidates.length !== 1) refuse();
  const selected = candidates[0];
  if (
    (await realpath(selected.manifest_path)) !== manifest ||
    (await realpath(selected.target.src_path)) !== main ||
    !Array.isArray(selected.features) ||
    selected.features.some((value) => value !== "default")
  )
    refuse();
  const name = process.platform === "win32" ? "opensesame.exe" : "opensesame";
  const executable = await realpath(selected.executable);
  if (executable !== (await realpath(join(target, "release", name)))) refuse();
  return { selected, main, name, executable };
}
async function stageReleasePackage(executable, name) {
  const original = await digest(executable, MAX_BINARY);
  const help = await runOriginal(executable, ["--help"]);
  if (help.output.length === 0) refuse();
  await writeFile(join(audit, "release-help.log"), help.output, {
    flag: "wx",
    mode: 0o600,
  });
  const packageRoot = join(
    audit,
    "release-package",
    "native-companion",
    `${process.platform}-${process.arch}`,
  );
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  const installed = join(packageRoot, name);
  await copyFile(executable, installed);
  if (process.platform !== "win32") await chmod(installed, 0o500);
  const copied = await digest(installed, MAX_BINARY);
  const current = await digest(executable, MAX_BINARY);
  if (
    copied.sha256 !== original.sha256 ||
    copied.bytes !== original.bytes ||
    current.revision !== original.revision ||
    current.sha256 !== original.sha256
  )
    refuse();
  const installedHelp = await runOriginal(installed, ["--help"]);
  if (!help.output.equals(installedHelp.output)) refuse();
  return { original, copied, installed, packageRoot };
}
async function verifyRegisteredWorker(main, installed) {
  // Current early prefixes lack worker registration. They carry honest CLI release evidence only.
  const registration = (
    await boundedBytes(main, 2 * 1024 * 1024)
  ).bytes.toString("utf8");
  const vaultArea = (
    await boundedBytes(
      await realpath("apps/cli/src/vault_area.rs"),
      2 * 1024 * 1024,
    )
  ).bytes.toString("utf8");
  const hasWorker =
    registration.includes("mod node_data_worker;") ||
    (registration.includes("mod vault_area;") &&
      vaultArea.includes(
        '#[path = "node_data_worker.rs"]\nmod node_data_worker;',
      ));
  let workerVerified = false;
  if (hasWorker) {
    const state = await mkdtemp(
      join(process.env.RUNNER_TEMP, "opensesame-release-worker-"),
    );
    const key = randomBytes(32);
    try {
      if (process.platform !== "win32") await chmod(state, 0o700);
      await writeFile(
        join(state, "at-rest.key"),
        `${key.toString("base64")}\n`,
        { flag: "wx", mode: 0o600 },
      );
      key.fill(0);
      const request = Buffer.from(
        JSON.stringify({ v: 1, op: { kind: "close" } }),
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(request.length);
      const reply = await runOriginal(
        installed,
        ["vault", "node-data", "--state", state],
        Buffer.concat([prefix, request]),
      );
      if (
        reply.output.length < 5 ||
        reply.output.readUInt32LE(0) !== reply.output.length - 4
      )
        refuse();
      const decoded = JSON.parse(reply.output.subarray(4).toString("utf8"));
      if (
        JSON.stringify(decoded) !==
        JSON.stringify({ v: 1, reply: { kind: "ack" } })
      )
        refuse();
      workerVerified = true;
    } finally {
      key.fill(0);
      await rm(state, { recursive: true, force: true });
    }
  }
  return { hasWorker, workerVerified };
}
async function writeFixedPackageManifest(
  packageRoot,
  name,
  copied,
  workerVerified,
) {
  if (workerVerified) {
    const fixed = {
      v: 1,
      protocol: "opensesame-node-data-v1",
      platform: process.platform,
      arch: process.arch,
      executable: name,
      sha256: copied.sha256,
      bytes: copied.bytes,
    };
    await writeFile(
      join(packageRoot, "manifest.json"),
      `${JSON.stringify(fixed)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
}
async function artifact() {
  head();
  if (
    !process.env.NATIVE_AUDIT_DIR ||
    !process.env.CARGO_TARGET_DIR ||
    !["linux", "darwin", "win32"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch)
  )
    refuse();
  const { selected, main, name, executable } = await selectReleaseExecutable();
  const { original, copied, installed, packageRoot } =
    await stageReleasePackage(executable, name);
  const { hasWorker, workerVerified } = await verifyRegisteredWorker(
    main,
    installed,
  );
  await writeFixedPackageManifest(packageRoot, name, copied, workerVerified);
  const installedFinal = await digest(installed, MAX_BINARY);
  if (
    installedFinal.revision !== copied.revision ||
    installedFinal.sha256 !== copied.sha256
  )
    refuse();
  head();
  const metadata = {
    v: 1,
    source: expected,
    platform: process.platform,
    arch: process.arch,
    nativeHost: process.env.NATIVE_HOST_TARGET,
    profile: "default-release",
    cargoArtifact: selected,
    cargoLockSha256: (await digest("Cargo.lock", 16 * 1024 * 1024)).sha256,
    original,
    installed: { path: installed, ...installedFinal },
    workerRegistered: hasWorker,
    workerCloseVerified: workerVerified,
    originalNodeLoaderExecuted: false,
  };
  await writeFile(
    join(audit, "release-provenance.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
await artifact();
