/** Unactivated raw-WASM compile driver. Inputs are downloaded separately. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
const [sourceInput, compilerInput, outputInput, ...extra] =
  process.argv.slice(2);
if (!sourceInput || !compilerInput || !outputInput || extra.length)
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
  const disk = await statfs(output, { bigint: true });
  if ((disk.blocks - disk.bfree) * disk.bsize > 27n * 1024n ** 3n)
    throw new Error(
      "Private compile disk-use limit exceeded; inspect before cleanup.",
    );
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
const inheritedNames = new Set([
  "PATH",
  "LANG",
  "TZ",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);
function environment(parent = process.env) {
  const env = {};
  for (const key of inheritedNames)
    if (parent[key] !== undefined) env[key] = parent[key];
  return Object.assign(env, {
    GOMAXPROCS: "2",
    GOMEMLIMIT: "2GiB",
    GOFLAGS: "-p=2 -buildvcs=false",
    GOTOOLCHAIN: "local",
    GOENV: "off",
    GOTELEMETRY: "off",
    GOCACHE: join(output, "cache", "build"),
    GOMODCACHE: join(output, "cache", "mod"),
    GOPATH: join(output, "cache", "gopath"),
    TMPDIR: join(output, "tmp"),
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GOPRIVATE: "",
    GONOPROXY: "",
    GONOSUMDB: "",
    VERSION_LONG: "",
    VERSION_SHORT: "",
  });
}
function live(state) {
  const child = state.child;
  return (
    owned.has(state) &&
    Number.isInteger(child.pid) &&
    child.pid > 1 &&
    child.exitCode === null &&
    child.signalCode === null
  );
}
function signalOwned(state, signal) {
  if (!live(state)) return;
  try {
    process.kill(-state.child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH")
      state.failure = "Could not signal owned compiler group.";
  }
}
function clearKill(state) {
  if (state.killTimer !== null) clearTimeout(state.killTimer);
  state.killTimer = null;
}
function terminate(state) {
  if (!live(state)) return;
  signalOwned(state, "SIGTERM");
  if (state.killTimer !== null) return;
  state.killTimer = setTimeout(() => signalOwned(state, "SIGKILL"), 5000);
}
function interrupt(signal) {
  interrupted ||= signal;
  for (const state of owned) terminate(state);
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
  return setInterval(() => {
    void checkDisk().catch(() => {
      if (!owned.has(state)) return;
      state.failure = "Private compile disk-use limit exceeded.";
      terminate(state);
    });
  }, 1000);
}
function settlement(state, name) {
  return new Promise((accept, reject) => {
    state.child.once("error", () =>
      reject(new Error(`${name} could not start.`)),
    );
    state.child.once("exit", (code) => {
      clearKill(state);
      if (code === 0 && !state.failure && !interrupted) accept();
      else
        reject(
          new Error(`${name} failed or was interrupted; read its private log.`),
        );
    });
  });
}
async function execute(program, args, name, verify = criticalPins) {
  if (interrupted) throw new Error("Private compile interrupted.");
  await checkDisk();
  await verify(`${name}:before`);
  const log = await open(join(logs, `${name}.log`), "w");
  if (interrupted) {
    await log.close();
    throw new Error("Private compile interrupted before child start.");
  }
  const child = spawn(program, args, {
    cwd: source,
    env: environment(),
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  const state = { child, killTimer: null, failure: "" };
  owned.add(state);
  const poll = monitor(state);
  try {
    await settlement(state, name);
  } finally {
    clearInterval(poll);
    clearKill(state);
    owned.delete(state);
    try {
      await verify(`${name}:after`);
    } finally {
      await log.close();
    }
  }
}
const helper = String.raw`package main
import ("encoding/json";"os";"tailscale.com/cmd/tsconnect/wasmbuild")
func main(){
 if len(os.Args)!=5 { panic("go phase output receipt required") }
 c:=wasmbuild.ProdCommand(os.Args[1],os.Args[3]);c.Stdout=os.Stdout;c.Stderr=os.Stderr
 r:=map[string]any{"phase":os.Args[2],"command":c.Args,"keep":wasmbuild.Keep,"tags":wasmbuild.Tags(),"ldflags":wasmbuild.ProdLDFlags()}
 e:=c.Run();r["pass"]=e==nil;if e!=nil {r["error"]=e.Error()}
 b,j:=json.MarshalIndent(r,"","  ");if j!=nil {panic(j)}
 if j=os.WriteFile(os.Args[4],append(b,'\n'),0600);j!=nil {panic(j)}
 if e!=nil {os.Exit(1)}
}`;
async function build(phase) {
  const go = join(compiler, "bin", "go");
  const artifact = join(artifacts, `${phase}.raw.wasm`);
  await execute(
    go,
    [
      "run",
      join(output, "upstream-command.go"),
      go,
      phase,
      artifact,
      join(output, `${phase}.json`),
    ],
    phase,
  );
  return { phase, sha256: await digest(artifact) };
}
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
  ];
  if (
    !Array.isArray(files) ||
    files.length !== names.length ||
    files.some((file, index) => file?.path !== names[index])
  )
    throw new Error("Only the five fixed native HTTP overlays may be staged.");
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
  await execute(
    join(compiler, "bin/go"),
    ["test", "-count=1", "-timeout=60s", "./cmd/tsconnect/nativehttp"],
    "native-http-host-test",
  );
}
async function run() {
  await freshOutput();
  await extractInputs();
  await stageNativeHttp();
  const baseline = await build("baseline");
  const repeated = await build("baseline-repeat");
  if (baseline.sha256 !== repeated.sha256)
    throw new Error("Baseline is not repeatable.");
  await patch();
  const expanded = await build("exit-feature");
  const expandedRepeat = await build("exit-feature-repeat");
  if (expanded.sha256 !== expandedRepeat.sha256)
    throw new Error("Feature build is not repeatable.");
  const result = {
    baseline,
    repeated,
    expanded,
    expandedRepeat,
    scope: pins.scope,
    integrity,
    childEnvironmentNames: Object.keys(environment()).sort(),
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
    "Raw compilation and owned host TLS tests complete; browser transport, peering and provider operations remain unrun.",
  );
} catch {
  process.exitCode = interrupted === "SIGINT" ? 130 : 1;
  if (interrupted === "SIGTERM") process.exitCode = 143;
  console.error(
    "Private raw build failed or was interrupted; inspect its private logs.",
  );
} finally {
  for (const state of owned) terminate(state);
  detachSignals();
}
