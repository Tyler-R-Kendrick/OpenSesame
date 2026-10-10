// Original frozen pnpm/child custody; every accepted process closes before delivery.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
const root = process.cwd();
const audit = resolve(process.env.NATIVE_AUDIT_DIR ?? "");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function run(id, command, args, cwd = root) {
  const chunks = [];
  let bytes = 0;
  let failure;
  let forced;
  const child = spawn(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const signalOriginal = (signal) => {
    try {
      child.kill(signal);
    } catch (error) {
      failure ??= error;
    }
  };
  const stop = () => {
    if (forced) return;
    forced = setTimeout(() => signalOriginal("SIGKILL"), 2000);
    signalOriginal("SIGTERM");
  };
  const record = (value) => {
    bytes += value.length;
    if (bytes > 16 * 1024 * 1024) {
      failure ??= new Error("Original bridge output bound exceeded.");
      stop();
    } else chunks.push(Buffer.from(value));
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.stdout.on("error", (error) => {
    failure ??= error;
    stop();
  });
  child.stderr.on("error", (error) => {
    failure ??= error;
    stop();
  });
  child.once("error", (error) => {
    failure ??= error;
  });
  const closed = new Promise((done) =>
    child.once("close", (code, signal) => done({ code, signal })),
  );
  const timer = setTimeout(
    () => {
      failure ??= new Error("Original bridge child timed out.");
      stop();
    },
    45 * 60 * 1000,
  );
  try {
    const result = await closed;
    await writeFile(join(audit, `${id}.log`), Buffer.concat(chunks), {
      flag: "wx",
      mode: 0o600,
    });
    if (failure || result.code !== 0 || result.signal)
      throw failure ?? new Error(`Original bridge command failed: ${id}`);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) stop();
    await closed;
    clearTimeout(forced);
  }
}
export async function originalPnpm(args, id, cwd) {
  const entry = process.env.npm_execpath;
  if (!entry || !/pnpm\.(?:cjs|js)$/.test(basename(entry)))
    throw new Error("Original frozen pnpm entry unavailable.");
  await run(id, process.execPath, [await realpath(entry), ...args], cwd);
}
export async function packageProduct(name, directory) {
  const output = join(audit, `packed-${name}`);
  await mkdir(output, { mode: 0o700 });
  await originalPnpm(
    ["pack", "--pack-destination", output],
    `pack-${name}`,
    directory,
  );
  const archives = (await readdir(output)).filter((value) =>
    value.endsWith(".tgz"),
  );
  if (archives.length !== 1)
    throw new Error("Original product archive unavailable.");
  const archive = join(output, archives[0]);
  await run(`extract-${name}`, "tar", ["-xzf", archive, "-C", output]);
  return {
    root: join(output, "package"),
    archive,
    sha256: sha(await readFile(archive)),
  };
}
