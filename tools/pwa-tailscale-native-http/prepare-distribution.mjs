/** Automatic build-only preparation; the installed PWA receives static deployment assets. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { nativeBuildEnvironment } from "./compose-native.mjs";
import {
  assertNativeSourceInputs,
  readNativeDistribution,
} from "./distribution-cache.mjs";
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

async function command(program, args, logPath, output, timeoutMs) {
  const taskRoot = resolve(output, "../..");
  await assertNativeTaskResources(taskRoot);
  const log = await open(logPath, "wx", 0o600);
  const child = spawn(program, args, {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: nativeBuildEnvironment(output, ""),
  });
  let interrupted = false;
  let completed = false;
  let force;
  const stop = () => {
    interrupted = true;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    force ??= setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 3000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const deadline = setTimeout(stop, timeoutMs);
  let checking = false;
  const monitoring = setInterval(() => {
    if (checking) return;
    checking = true;
    void assertNativeTaskResources(taskRoot)
      .catch(() => {
        if (!completed) stop();
      })
      .finally(() => {
        checking = false;
      });
  }, 1000);
  try {
    await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 && !interrupted
          ? accept()
          : reject(
              new Error(
                "Native asset preparation failed; retained build log contains the details.",
              ),
            ),
      );
    });
  } finally {
    completed = true;
    clearInterval(monitoring);
    clearTimeout(deadline);
    clearTimeout(force);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await log.close();
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
  await command(
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
    await command(
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
