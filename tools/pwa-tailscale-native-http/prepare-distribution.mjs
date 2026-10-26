/** Automatic build-only preparation; the installed PWA receives static deployment assets. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cleanupNativeAuditScratch } from "./audit-scratch.mjs";
import { nativeBuildEnvironment } from "./compose-native.mjs";
import {
  assertNativeSourceInputs,
  readNativeDistribution,
} from "./distribution-cache.mjs";
import {
  OUTER_GROUP_GRACE_MS,
  startOwnedCommand,
  stopOwnedCommand,
} from "./owned-process-group.mjs";
import { describePreparationFailure } from "./preparation-diagnostics.mjs";
import { assertNativeTaskResources } from "./task-resources.mjs";
const digestPattern = /^[a-f0-9]{64}$/;
const inFlight = new Map();
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** The pinned executable compiler is Linux AMD64; cached static assets are host-independent. */
export function assertNativeColdBuildHost(
  platform = process.platform,
  architecture = process.arch,
) {
  if (platform !== "linux" || architecture !== "x64")
    throw new Error(
      "Cold native WASM preparation requires the pinned Linux AMD64 build host; this host cannot execute that compiler. Verified cached static distributions remain portable.",
    );
}
async function present(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
export function nativeDistributionDirectory(
  repositoryRoot,
  sourceSha256,
  distributionSha256,
) {
  if (
    !digestPattern.test(sourceSha256) ||
    !digestPattern.test(distributionSha256)
  )
    throw new Error("Native runtime input pins are invalid.");
  return join(
    resolve(repositoryRoot),
    ".cache/pwa-tailscale-native-http/distributions",
    sourceSha256,
    distributionSha256,
  );
}
async function verifyArchive(path, digest) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 1_073_741_824)
      throw new Error("Native build archive size is invalid.");
    if (hash(await handle.readFile()) !== digest)
      throw new Error("Native build archive digest differs.");
  } finally {
    await handle.close();
  }
}

/** Internal build-tool command boundary; exported for actual owned-child failure tests. */
export async function nativePreparationCommand(
  program,
  args,
  logPath,
  output,
  timeoutMs,
) {
  const taskRoot = resolve(output, "../..");
  await assertNativeTaskResources(taskRoot);
  const log = await open(logPath, "wx", 0o600);
  const observation = { reason: "exit", exitCode: null, signal: null };
  const state = await startOwnedCommand({
    program,
    args,
    env: nativeBuildEnvironment(output, ""),
    stdio: ["ignore", log.fd, log.fd],
    observation,
    graceMs: OUTER_GROUP_GRACE_MS,
    failureMessage:
      "Native asset preparation failed; retained build log contains the details.",
  });
  let completed = false;
  const stop = (reason) => stopOwnedCommand(state, reason);
  const terminated = () => stop("SIGTERM");
  const interruptedByUser = () => stop("SIGINT");
  process.on("SIGTERM", terminated);
  process.on("SIGINT", interruptedByUser);
  const deadline = setTimeout(() => stop("timeout"), timeoutMs);
  let checking = false;
  const monitoring = setInterval(() => {
    if (checking) return;
    checking = true;
    void assertNativeTaskResources(taskRoot)
      .catch(() => {
        if (!completed) stop("resource");
      })
      .finally(() => {
        checking = false;
      });
  }, 1000);
  let failure;
  try {
    await state.done;
  } catch (error) {
    failure = error;
  } finally {
    completed = true;
    clearInterval(monitoring);
    clearTimeout(deadline);
    process.off("SIGTERM", terminated);
    process.off("SIGINT", interruptedByUser);
    await log.close();
  }
  if (failure) {
    if (
      observation.exitCode === 125 ||
      observation.signal ||
      state.anchorSignal
    ) {
      failure.code = "NATIVE_GROUP_DRAIN";
      failure.message +=
        " Nested process-group drain is uncertain; owned scratch is retained.";
    }
    await describePreparationFailure(failure, output, logPath, observation);
    throw failure;
  }
}
async function archive(pin, cache, work, label) {
  if (
    !digestPattern.test(pin.archiveSha256) ||
    new URL(pin.archiveURL).protocol !== "https:"
  )
    throw new Error("Native archive pin is invalid.");
  const path = join(cache, `${pin.archiveSha256}.tar.gz`);
  if (await present(path)) {
    await verifyArchive(path, pin.archiveSha256);
    return path;
  }
  const partial = join(work, `${label}.download`);
  await nativePreparationCommand(
    "curl",
    [
      "--fail",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "120",
      "--max-filesize",
      "1073741824",
      "--output",
      partial,
      "--",
      pin.archiveURL,
    ],
    join(work, `${label}-download.log`),
    work,
    125_000,
  );
  await verifyArchive(partial, pin.archiveSha256);
  await rename(partial, path);
  return path;
}
function assertBuildProof(result) {
  const phases = [
    [result.baseline, "baseline"],
    [result.repeated, "baseline-repeat"],
    [result.expanded, "exit-feature"],
    [result.expandedRepeat, "exit-feature-repeat"],
  ];
  if (
    phases.some(
      ([entry, phase]) =>
        entry?.phase !== phase ||
        !digestPattern.test(entry?.sha256 ?? "") ||
        !Array.isArray(result.integrity) ||
        !result.integrity.some(
          (check) => check.stage === `${phase}:before` && check.pass === true,
        ) ||
        !result.integrity.some(
          (check) => check.stage === `${phase}:after` && check.pass === true,
        ),
    ) ||
    result.baseline.sha256 !== result.repeated.sha256 ||
    result.expanded.sha256 !== result.expandedRepeat.sha256 ||
    result.ownedGroupsRemaining !== 0
  )
    throw new Error(
      "Native four-phase repetition or process-ownership proof differs.",
    );
}
async function prepare(repositoryRoot, sourceSha256, distributionSha256) {
  const here = join(resolve(repositoryRoot), "tools/pwa-tailscale-native-http");
  const pins = await assertNativeSourceInputs(here, sourceSha256);
  const taskRoot = join(
    resolve(repositoryRoot),
    ".cache/pwa-tailscale-native-http",
  );
  if (await present(taskRoot)) await assertNativeTaskResources(taskRoot);
  const directory = nativeDistributionDirectory(
    repositoryRoot,
    sourceSha256,
    distributionSha256,
  );
  const readCached = async () => {
    const result = await readNativeDistribution(directory, distributionSha256);
    await assertNativeSourceInputs(here, sourceSha256);
    return { directory, ...result };
  };
  if (await present(directory)) return readCached();
  assertNativeColdBuildHost();
  await mkdir(dirname(directory), { recursive: true });
  const lock = `${directory}.lock`;
  const waiting = performance.now() + 600_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await present(directory)) return readCached();
      if (performance.now() >= waiting)
        throw new Error(
          "Timed out waiting for the same pinned native runtime preparation.",
        );
      await new Promise((accept) => setTimeout(accept, 200));
    }
  }
  try {
    if (await present(directory)) return readCached();
    const root = join(
      resolve(repositoryRoot),
      ".cache/pwa-tailscale-native-http",
    );
    const work = join(root, "work", randomUUID());
    const archives = join(root, "archives");
    await mkdir(work, { recursive: true });
    await mkdir(join(work, "tmp"));
    await mkdir(archives, { recursive: true });
    const source = await archive(pins.source, archives, work, "source");
    const compiler = await archive(pins.compiler, archives, work, "compiler");
    const output = join(work, "build");
    await nativePreparationCommand(
      process.execPath,
      [join(here, "build.mjs"), source, compiler, output],
      join(work, "build.log"),
      work,
      600_000,
    );
    await assertNativeSourceInputs(here, sourceSha256);
    const built = join(output, "artifacts");
    const result = JSON.parse(
      await readFile(join(output, "result.json"), "utf8"),
    );
    assertBuildProof(result);
    const verified = await readNativeDistribution(built, distributionSha256);
    if (
      verified.manifest.rawWasm.sha256 !== result.expanded.sha256 ||
      verified.manifest.sourceCommit !== pins.source.commit ||
      verified.manifest.compilerCommit !== pins.compiler.commit
    )
      throw new Error(
        "Native emitted assets do not match the exact source/compiler build.",
      );
    await rename(built, directory);
    return readCached();
  } finally {
    await rm(lock, { recursive: true });
  }
}
/** All normal Vite callers share one preparation; failures remain failures and retain their work. */
export async function prepareNativeDistribution(
  repositoryRoot,
  sourceSha256,
  distributionSha256,
) {
  const key = nativeDistributionDirectory(
    repositoryRoot,
    sourceSha256,
    distributionSha256,
  );
  let promise = inFlight.get(key);
  if (!promise) {
    promise = prepare(repositoryRoot, sourceSha256, distributionSha256);
    inFlight.set(key, promise);
  }
  try {
    return await promise;
  } finally {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
}

/** Reuse exact preparation and verification, but inspect packages without four WASM compilations. */
export async function prepareNativeAudit(
  repositoryRoot,
  sourceSha256,
  auditDirectory,
) {
  const here = join(resolve(repositoryRoot), "tools/pwa-tailscale-native-http");
  const pins = await assertNativeSourceInputs(here, sourceSha256);
  const owner = auditDirectory
    ? resolve(auditDirectory)
    : await mkdtemp(join(tmpdir(), "opensesame-native-audit-"));
  const task = join(owner, "native-go");
  const work = join(task, "work", randomUUID());
  const archives = join(
    resolve(repositoryRoot),
    ".cache/pwa-tailscale-native-http/archives",
  );
  let retainScratch = false;
  try {
    await mkdir(join(work, "tmp"), { recursive: true, mode: 0o700 });
    await mkdir(archives, { recursive: true });
    const source = await archive(pins.source, archives, work, "source");
    const compiler = await archive(pins.compiler, archives, work, "compiler");
    const output = join(work, "audit");
    await nativePreparationCommand(
      process.execPath,
      [join(here, "build.mjs"), source, compiler, output, "--audit"],
      join(work, "audit.log"),
      work,
      600_000,
    );
    await assertNativeSourceInputs(here, sourceSha256);
    const result = JSON.parse(
      await readFile(join(output, "native-audit.json"), "utf8"),
    );
    if (
      result.compilerVersion !== pins.compiler.version ||
      result.affectedImportedPackages !== 0
    )
      throw new Error(
        "Native package audit receipt differs from the selected compiler.",
      );
    return result;
  } catch (error) {
    retainScratch = error?.code === "NATIVE_GROUP_DRAIN";
    throw error;
  } finally {
    if (!retainScratch) await cleanupNativeAuditScratch(work);
  }
}
