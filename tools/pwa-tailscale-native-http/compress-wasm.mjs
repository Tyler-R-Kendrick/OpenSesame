/** Build-only, source-pinned lossless gzip. No compressor is shipped to the PWA. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { nativeBuildEnvironment } from "./compose-native.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const compressorPin = Object.freeze({
  version: "2.8",
  archiveURL: "https://zlib.net/pigz/pigz-2.8.tar.gz",
  archiveSha256:
    "eb872b4f0e1f0ebe59c9f7bd8c506c4204893ba6a8492de31df416f0d5170fd0",
  arguments: Object.freeze([
    "-11",
    "-I",
    "3",
    "-p",
    "2",
    "-b",
    "1024",
    "-n",
    "-c",
  ]),
});

let commandNumber = 0;
async function run(program, args, cwd, env, timeout, maxBuffer = 4_194_304) {
  const child = spawn(program, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failed = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout = [];
  const stderr = [];
  const stop = () => {
    failed = true;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(stop, timeout);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.stdout.on("data", (bytes) => {
    stdoutBytes += bytes.length;
    if (stdoutBytes > maxBuffer) stop();
    else stdout.push(bytes);
  });
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 4_194_304) stop();
    else stderr.push(bytes);
  });
  let exit;
  try {
    exit = await new Promise((accept) => {
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code, signal) => accept({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  const bytes = Buffer.concat(stdout);
  writeFileSync(
    join(env.TMPDIR, `command-${++commandNumber}.log`),
    Buffer.concat([
      Buffer.from(`${program}\nexit=${exit.code}; signal=${exit.signal}\n`),
      ...stderr,
      program.endsWith("/pigz") && args[0] === "-11" ? Buffer.alloc(0) : bytes,
    ]),
    { flag: "wx" },
  );
  if (failed || exit.code !== 0 || exit.signal) {
    stop();
    throw new Error("Pinned native compressor command failed.");
  }
  return bytes;
}

export function verifyCompressedWasm(compressed, raw, expectedRawSha256) {
  if (hash(raw) !== expectedRawSha256 || raw.length > 67_108_864)
    throw new Error("Native compressor raw input changed.");
  const decoded = gunzipSync(compressed, { maxOutputLength: raw.length });
  if (!decoded.equals(raw) || !WebAssembly.validate(decoded))
    throw new Error("Native compression changed the raw WASM.");
  return compressed;
}

export async function compressNativeWasm({
  raw,
  wasmSha256,
  output,
  archivePath,
}) {
  if (hash(raw) !== wasmSha256 || raw.length > 67_108_864)
    throw new Error("Native compressor raw input changed.");
  const work = join(output, "compressor");
  await mkdir(work);
  await mkdir(join(work, "tmp"));
  const env = nativeBuildEnvironment(work, "");
  const archive = join(work, "pigz-2.8.tar.gz");
  if (archivePath) {
    await writeFile(archive, await readFile(archivePath), { flag: "wx" });
  } else {
    await run(
      "curl",
      [
        "--fail",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-time",
        "30",
        "--max-filesize",
        "1048576",
        "--output",
        archive,
        compressorPin.archiveURL,
      ],
      work,
      env,
      35_000,
    );
  }
  const archiveBytes = await readFile(archive);
  if (
    archiveBytes.length > 1_048_576 ||
    hash(archiveBytes) !== compressorPin.archiveSha256
  )
    throw new Error("Native compressor archive differs from its official pin.");
  await run(
    "tar",
    ["-xzf", archive, "--no-same-owner", "--no-same-permissions"],
    work,
    env,
    10_000,
  );
  const source = join(work, "pigz-2.8");
  const buildLog = await run("make", ["-j2", "pigz"], source, env, 30_000);
  await writeFile(join(work, "build.log"), buildLog, { flag: "wx" });
  const executable = join(source, "pigz");
  const version = (await run(executable, ["--version"], work, env, 1000))
    .toString()
    .trim();
  if (version !== "pigz 2.8")
    throw new Error("Native compressor version differs.");
  const input = join(work, "native.raw.wasm");
  await writeFile(input, raw, { flag: "wx" });
  const compressed = verifyCompressedWasm(
    await run(
      executable,
      [...compressorPin.arguments, "--", input],
      work,
      env,
      60_000,
      67_108_864,
    ),
    raw,
    wasmSha256,
  );
  const receipt = {
    ...compressorPin,
    executableSha256: hash(await readFile(executable)),
    compiler: (await run("gcc", ["--version"], work, env, 1000))
      .toString()
      .split("\n")[0],
    rawWasm: { sha256: wasmSha256, bytes: raw.length },
    gzip: { sha256: hash(compressed), bytes: compressed.length },
    notices: [],
  };
  for (const path of ["README", "zopfli/COPYING"]) {
    const bytes = await readFile(join(source, path));
    receipt.notices.push({ path, sha256: hash(bytes), bytes: bytes.length });
  }
  await writeFile(
    join(work, "provenance.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  return compressed;
}
