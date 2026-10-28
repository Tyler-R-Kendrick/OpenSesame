/** Failure-only observations of the outer preparation command, never compiler proof. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { constants as operatingSystem } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

const MAX_BYTES = 1_048_576;
const MAX_FILE_BYTES = 262_144;
const MAX_CONTEXT_BYTES = 16_384;
const phases = new Map([
  ["build.log", "native-build"],
  ["source-download.log", "source-download"],
  ["compiler-download.log", "compiler-download"],
]);
const reasons = new Set([
  "exit",
  "spawn",
  "timeout",
  "resource",
  "descendant",
  "SIGINT",
  "SIGTERM",
]);
const signals = new Set(Object.keys(operatingSystem.signals));
const codes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "ENOMEM",
  "EAGAIN",
  "NATIVE_GROUP_DRAIN",
]);
const innerLogs = [
  "exit-feature-repeat",
  "exit-feature",
  "apply-feature",
  "baseline-repeat",
  "baseline",
  "native-http-host-test",
  "native-node-host-test",
  "disable-remote-logtail",
  "native-node-patch",
  "native-ssh-patch",
  "select-native-toolchain",
  "extract-compiler",
  "extract-source",
];

/** The reviewed CI redaction rules, applied before any new diagnostic output. */
export function redactPreparationLog(text) {
  return text
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      "[REDACTED]",
    )
    .replace(/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/, "[REDACTED]")
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:token|access_token|refresh_token|id_token|api[_-]?key|key|secret|password|passwd|signature|sig|code|credential|auth|client_secret|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-signature)=)[^&#\s"'<>]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:proxy-)?authorization|(?:set-)?cookie)["']?\s*[:=]\s*[^\r\n]*/gi,
      "$1: [REDACTED]",
    )
    .replace(
      /\b([A-Za-z0-9_-]{0,64}(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|private[_-]?key|auth[_-]?key)[A-Za-z0-9_-]{0,64}["']?\s*[:=]\s*)[^\r\n]*/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z\d._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|tskey-(?:auth|api|client)-|sk-(?:live-|proj-)?)[A-Za-z\d_-]{16,}\b/g,
      "[REDACTED]",
    );
}

function bounded(text, bytes) {
  return Buffer.from(text).subarray(0, bytes).toString("utf8");
}
async function ordinaryParents(path) {
  let current = parse(path).root;
  for (const name of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, name);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
  }
  return true;
}
function sameFile(prior, next) {
  return (
    prior.dev === next.dev &&
    prior.ino === next.ino &&
    prior.size === next.size &&
    prior.mtimeMs === next.mtimeMs &&
    next.nlink === 1
  );
}
async function readTail(handle, prior, budget) {
  const size = Math.min(prior.size, MAX_FILE_BYTES, budget.remaining);
  // Reserve before reading: unstable or refused files still consume the IO budget.
  budget.remaining -= size;
  const start = prior.size - size;
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(
      bytes,
      offset,
      size - offset,
      start + offset,
    );
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  const body = bytes.subarray(0, offset);
  const boundary = start ? body.indexOf(10) : -1;
  if (start && boundary === -1) return { text: "", bytes: offset };
  return {
    text: redactPreparationLog(
      body.subarray(start ? boundary + 1 : 0).toString("utf8"),
    ),
    bytes: offset,
  };
}
async function readLog(path, budget) {
  let handle;
  try {
    if (!(await ordinaryParents(dirname(path)))) return null;
    const prior = await lstat(path);
    if (
      !prior.isFile() ||
      prior.isSymbolicLink() ||
      prior.nlink !== 1 ||
      !Number.isSafeInteger(prior.size)
    )
      return null;
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!sameFile(prior, await handle.stat())) return null;
    const result = await readTail(handle, prior, budget);
    if (
      !sameFile(prior, await handle.stat()) ||
      !sameFile(prior, await lstat(path)) ||
      !(await ordinaryParents(dirname(path)))
    )
      return null;
    return result;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
function ownedWork(work, logPath) {
  return (
    resolve(work) === work &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      basename(work),
    ) &&
    basename(dirname(work)) === "work" &&
    basename(dirname(dirname(work))) === "pwa-tailscale-native-http" &&
    basename(dirname(dirname(dirname(work)))) === ".cache" &&
    dirname(logPath) === work &&
    phases.has(basename(logPath))
  );
}
async function logsFor(work, logPath) {
  const names = [basename(logPath)];
  if (basename(logPath) === "build.log")
    names.push(...innerLogs.map((name) => `build/logs/${name}.log`));
  const logs = [];
  const budget = { remaining: MAX_BYTES };
  for (const name of names) {
    if (!budget.remaining) break;
    const result = await readLog(join(work, name), budget);
    if (!result) continue;
    if (result.text) logs.push({ name, tail: result.text });
  }
  return logs;
}
function outcome(phase, state, error) {
  return {
    schemaVersion: 1,
    scope: "outer-preparation-command-only",
    innerCompilerExit: "unknown",
    phase,
    reason: reasons.has(state.reason) ? state.reason : "exit",
    exitCode: Number.isSafeInteger(state.exitCode) ? state.exitCode : null,
    signal: signals.has(state.signal) ? state.signal : null,
    spawnCode: codes.has(error?.code) ? error.code : null,
    error:
      error instanceof Error
        ? bounded(redactPreparationLog(error.message), 1024)
        : "Native preparation failed.",
  };
}
async function saveReceipt(work, record) {
  const path = join(work, `native-preparation-${record.phase}-failure.json`);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > MAX_BYTES || !(await ordinaryParents(work))) return false;
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const prior = await handle.stat();
    if (!prior.isFile() || prior.nlink !== 1) return false;
    await handle.writeFile(bytes);
    const after = await handle.stat();
    return (
      sameFile(after, await lstat(path)) &&
      after.size === bytes.length &&
      prior.dev === after.dev &&
      prior.ino === after.ino &&
      (await ordinaryParents(work))
    );
  } finally {
    await handle.close();
  }
}
function contextFor(record) {
  const { logs, ...metadata } = record;
  let text = `Native preparation diagnostics (outer command only; inner compiler exit unknown):\n${JSON.stringify(metadata)}\n`;
  for (const log of logs) {
    const available = MAX_CONTEXT_BYTES - Buffer.byteLength(text) - 512;
    if (available <= 0) break;
    const tail = Buffer.from(log.tail);
    text += `--- ${log.name} (redacted tail) ---\n${tail.subarray(Math.max(0, tail.length - Math.min(4096, available))).toString("utf8")}\n`;
  }
  return bounded(text, MAX_CONTEXT_BYTES - 3072);
}
/** Best-effort diagnostics preserve the exact initiating Error, code, cause and cleanup. */
export async function describePreparationFailure(error, work, logPath, state) {
  try {
    if (
      !(error instanceof Error) ||
      !ownedWork(work, logPath) ||
      !(await ordinaryParents(work))
    )
      return;
    const record = outcome(phases.get(basename(logPath)), state, error);
    record.logs = await logsFor(work, logPath);
    // JSON escaping can expand the read budget; trim whole records instead of raw JSON.
    while (Buffer.byteLength(JSON.stringify(record)) + 1 > MAX_BYTES)
      record.logs.pop();
    await saveReceipt(work, record).catch(() => false);
    const context = contextFor(record);
    const message = bounded(redactPreparationLog(error.message), 1024);
    const stack = bounded(
      redactPreparationLog(error.stack ?? error.message),
      2048,
    );
    error.message = `${message}\n${context}`;
    error.stack = `${stack}\n${context}`;
  } catch {
    // Refused paths, disk pressure, or read/write failures never replace the original failure.
  }
}

/** Failure-only inner-driver context; preserve the initiating Error and cause. */
export function nativeBuildFailureContext(error, stage, command) {
  try {
    const code = error instanceof Error ? error.code : null;
    const metadata = {
      schemaVersion: 1,
      scope: "native-build-driver-only",
      stage: /^[a-z-]{1,80}$/.test(stage) ? stage : "unknown",
      lastCommand: command
        ? {
            phase: /^[a-z-]{1,80}$/.test(command.phase)
              ? command.phase
              : "unknown",
            reason: reasons.has(command.reason) ? command.reason : "unknown",
            exitCode: Number.isSafeInteger(command.exitCode)
              ? command.exitCode
              : null,
            signal: signals.has(command.signal) ? command.signal : null,
            spawnCode: codes.has(command.spawnCode) ? command.spawnCode : null,
          }
        : null,
      errorCode: [
        ...codes,
        "ENOSPC",
        "EIO",
        "EEXIST",
        "ENOTDIR",
        "ENOSYS",
        "EMFILE",
      ].includes(code)
        ? code
        : null,
    };
    const stack =
      error instanceof Error
        ? (error.stack ?? error.message)
        : "Native build failed with an unknown error.";
    return `Native build driver diagnostics (not a compiler proof):\n${JSON.stringify(metadata)}\n${bounded(redactPreparationLog(stack), 4096)}`;
  } catch {
    return "Native build driver diagnostics unavailable; original failure retained.";
  }
}
