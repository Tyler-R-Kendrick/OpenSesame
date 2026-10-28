/** Unactivated raw-WASM compile driver. Inputs are downloaded separately. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePatchCommand } from "./apply-native-patch.mjs";
import { composeNative, nativeBuildEnvironment } from "./compose-native.mjs";
import { emitNativeAssets } from "./native-assets.mjs";
import {
  auditNativePackages,
  compileNativePhase,
  upstreamCompileHelper as helper,
} from "./native-audit.mjs";
import { openNativeCommandLogs } from "./native-command-io.mjs";
import {
  INNER_GROUP_GRACE_MS,
  startOwnedCommand,
  stopOwnedCommand,
} from "./owned-process-group.mjs";
import { nativeBuildFailureContext } from "./preparation-diagnostics.mjs";
import { assertNativeTaskResources } from "./task-resources.mjs";
const here = fileURLToPath(new URL(".", import.meta.url));
const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
const [sourceInput, compilerInput, outputInput, mode, ...extra] =
  process.argv.slice(2);
if (
  !sourceInput ||
  !compilerInput ||
  !outputInput ||
  extra.length ||
  (mode !== undefined && mode !== "--audit")
)
  throw new Error(
    "Pass source archive, compiler archive, and a fresh output directory.",
  );
const output = resolve(outputInput);
const source = join(output, "source");
const compiler = join(output, "compiler");
const logs = join(output, "logs");
const artifacts = join(output, "artifacts");
const integrity = [];
const owned = new Set();
let interrupted = "";
let nativeHttpStaged = false;
let moduleFlags = "-p=2 -buildvcs=false";
let verifyNative = null;
let buildStage = "initialization";
let lastCommand = null;

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function requireHash(path, expected) {
  if ((await digest(path)) !== expected)
    throw new Error("Pinned input digest differs.");
}
async function verifyFiles(base, files, stage) {
  for (const file of files)
    await requireHash(join(base, file.path), file.sha256);
  integrity.push({ stage, paths: files.map((file) => file.path), pass: true });
}
async function sourcePins(stage) {
  await verifyFiles(source, pins.source.criticalFiles, stage);
}
async function criticalPins(stage) {
  await sourcePins(stage);
  await verifyFiles(compiler, pins.compiler.criticalFiles, stage);
  if (verifyNative) await verifyNative();
  if (nativeHttpStaged) {
    await verifyFiles(here, pins.nativeHttp.files, `${stage}:overlay-source`);
    await verifyFiles(
      join(source, "cmd/tsconnect/nativehttp"),
      pins.nativeHttp.files,
      `${stage}:overlay-staged`,
    );
  }
}
async function archivePins(stage) {
  await requireHash(resolve(sourceInput), pins.source.archiveSha256);
  await requireHash(resolve(compilerInput), pins.compiler.archiveSha256);
  integrity.push({ stage, archives: 2, pass: true });
}
async function checkDisk() {
  await assertNativeTaskResources(output);
}

async function freshOutput() {
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error("Use a fresh output directory.");
  for (const directory of [
    source,
    compiler,
    logs,
    artifacts,
    join(output, "tmp"),
  ])
    await mkdir(directory, { recursive: true });
  await checkDisk();
}
function interrupt(signal) {
  interrupted ||= signal;
  for (const state of owned) stopOwnedCommand(state, signal);
}
const onInt = () => interrupt("SIGINT");
const onTerm = () => interrupt("SIGTERM");
function attachSignals() {
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
}
function detachSignals() {
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
}
function monitor(state) {
  let checking = false;
  return setInterval(() => {
    if (checking) return;
    checking = true;
    void checkDisk()
      .catch(() => {
        if (!owned.has(state)) return;
        state.failure = "Native task resource limit exceeded.";
        stopOwnedCommand(state, "resource");
      })
      .finally(() => {
        checking = false;
      });
  }, 1000);
}

async function execute(
  program,
  args,
  name,
  verify = criticalPins,
  options = {},
) {
  buildStage = name;
  if (interrupted) throw new Error("Private compile interrupted.");
  await checkDisk();
  await verify(`${name}:before`);
  const { log, stdout } = await openNativeCommandLogs({
    logs,
    name,
    interrupted,
    stdoutPath: options.stdoutPath,
  });
  const command = nativePatchCommand(program, args);
  lastCommand = {
    phase: name,
    exitCode: null,
    signal: null,
    spawnCode: null,
    reason: "exit",
  };
  const state = await startOwnedCommand({
    program: command.program,
    args: command.args,
    cwd: source,
    env: options.env ?? nativeBuildEnvironment(output, moduleFlags),
    stdio: ["ignore", stdout?.fd ?? log.fd, log.fd],
    observation: lastCommand,
    graceMs: INNER_GROUP_GRACE_MS,
    failureMessage: `${name} failed or was interrupted; read its private log.`,
  });
  owned.add(state);
  const poll = monitor(state);
  let failure;
  try {
    await state.done;
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(poll);
    if (state.drained) owned.delete(state);
    try {
      await verify(`${name}:after`);
    } catch (error) {
      failure ??= error;
    }
    try {
      await log.close();
      await stdout?.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
const build = (phase) =>
  compileNativePhase(phase, {
    compiler,
    artifacts,
    output,
    execute,
    digest,
  });
async function patch() {
  const patchPath = join(here, "exit-route.patch");
  await requireHash(patchPath, pins.patch.sha256);
  const file = join(source, pins.patch.path);
  await requireHash(file, pins.patch.beforeSha256);
  await execute(
    "patch",
    ["--batch", "--forward", "-p1", "-i", patchPath],
    "apply-feature",
  );
  await requireHash(file, pins.patch.afterSha256);
}
async function extractInputs() {
  await archivePins("initial");
  await execute(
    "tar",
    ["-xzf", resolve(sourceInput), "--strip-components=1", "-C", source],
    "extract-source",
    archivePins,
  );
  await sourcePins("source-extracted");
  await execute(
    "tar",
    ["-xzf", resolve(compilerInput), "--strip-components=1", "-C", compiler],
    "extract-compiler",
    sourcePins,
  );
  await criticalPins("inputs-extracted");
  await writeFile(join(output, "upstream-command.go"), helper);
}
async function stageNativeHttp() {
  const files = pins.nativeHttp.files;
  const names = [
    "nativehttp.go",
    "nativehttp_test.go",
    "nativehttp_security_test.go",
    "draining.go",
    "draining_test.go",
    "operations.go",
    "operations_test.go",
    "operations_tls_test.go",
    "streaming.go",
    "streaming_test.go",
    "streaming_drain_test.go",
  ];
  if (
    !Array.isArray(files) ||
    files.length !== names.length ||
    files.some((file, index) => file?.path !== names[index])
  )
    throw new Error(
      "Only the eleven fixed native HTTP overlays may be staged.",
    );
  for (const file of files)
    await requireHash(join(here, file.path), file.sha256);
  const directory = join(source, "cmd/tsconnect/nativehttp");
  await mkdir(directory);
  for (const file of files)
    await writeFile(
      join(directory, file.path),
      await readFile(join(here, file.path)),
      { flag: "wx", mode: 0o600 },
    );
  nativeHttpStaged = true;
  await criticalPins("native-http-staged");
}
async function run() {
  buildStage = "fresh-output";
  await freshOutput();
  buildStage = "extract-inputs";
  await extractInputs();
  buildStage = "native-http-staging";
  await stageNativeHttp();
  buildStage = "compose-native";
  const composed = await composeNative({
    here,
    source,
    output,
    pins,
    execute,
    requireHash,
  });
  moduleFlags = composed.flags;
  verifyNative = composed.verify;
  if (mode === "--audit") {
    await patch();
    await auditNativePackages({ output, compiler, pins, execute });
    return;
  }
  await execute(
    join(compiler, "bin/go"),
    ["test", "-count=1", "-timeout=60s", "./cmd/tsconnect/nativehttp"],
    "native-http-host-test",
  );
  await execute(
    join(compiler, "bin/go"),
    ["test", "-count=1", "-timeout=60s", "./cmd/tsconnect/wasm"],
    "native-node-host-test",
  );
  const baseline = await build("baseline");
  const repeated = await build("baseline-repeat");
  if (baseline.sha256 !== repeated.sha256)
    throw new Error("Baseline is not repeatable.");
  await patch();
  const expanded = await build("exit-feature");
  const expandedRepeat = await build("exit-feature-repeat");
  if (expanded.sha256 !== expandedRepeat.sha256)
    throw new Error("Feature build is not repeatable.");
  await checkDisk();
  const distribution = await emitNativeAssets({
    here,
    repositoryRoot: resolve(here, "../.."),
    source,
    compiler,
    output: artifacts,
    wasm: join(artifacts, "exit-feature.raw.wasm"),
    wasmSha256: expanded.sha256,
    pins,
    requireHash,
  });
  await checkDisk();
  await criticalPins("distribution-complete");
  const result = {
    distribution,
    baseline,
    repeated,
    expanded,
    expandedRepeat,
    scope: pins.scope,
    integrity,
    childEnvironmentNames: Object.keys(
      nativeBuildEnvironment(output, moduleFlags),
    ).sort(),
    ownedGroupsRemaining: owned.size,
  };
  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}
attachSignals();
try {
  await run();
  console.log(
    mode === "--audit"
      ? "Pinned production native package audit completed."
      : "Pinned native artifacts emitted; PWA activation and provider-operation verification remain required.",
  );
} catch (error) {
  process.exitCode =
    error?.code === "NATIVE_GROUP_DRAIN"
      ? 125
      : interrupted === "SIGINT"
        ? 130
        : 1;
  if (interrupted === "SIGTERM" && error?.code !== "NATIVE_GROUP_DRAIN")
    process.exitCode = 143;
  console.error(
    "Private raw build failed or was interrupted; inspect its private logs.",
  );
  console.error(nativeBuildFailureContext(error, buildStage, lastCommand));
} finally {
  for (const state of owned) {
    stopOwnedCommand(state, "shutdown");
    await state.done.catch(() => {});
  }
  detachSignals();
}
