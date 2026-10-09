import { spawn, spawnSync } from "node:child_process";
/** Failure-only inspection of the already tested executable, without rebuilding. */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import {
  prologueRanges,
  windowsStackReport,
  windowsUnwindCollector,
} from "../lib/native-windows-stack-report.mjs";

const MAX_TOOL_BYTES = 32 * 1024 * 1024;
const deadline = Date.now() + 180_000;

function environment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing diagnostic input: ${name}`);
  return value;
}

function run(tool, args, output, label, timeoutMs = 30_000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new Error("Windows stack diagnostic deadline reached.");
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    maxBuffer: MAX_TOOL_BYTES,
    timeout: Math.min(timeoutMs, remaining),
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(path.join(output, `${label}.stdout.log`), stdout);
  writeFileSync(path.join(output, `${label}.stderr.log`), stderr);
  return {
    stdout,
    receipt: {
      tool: path.basename(tool),
      args,
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code ?? null,
      outputLimitBytes: MAX_TOOL_BYTES,
    },
  };
}

function unwindRecords(child, collector, state) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let parserStopped = false;
  return async function* records(source) {
    for await (const chunk of source) {
      const remaining = 512 * 1024 * 1024 - state.bytes;
      const captured = chunk.subarray(0, Math.max(0, remaining));
      if (captured.length !== chunk.length) {
        state.toolError = "STDOUT_LIMIT";
        child.kill();
      }
      state.bytes += captured.length;
      state.hash.update(captured);
      if (!parserStopped) {
        pending += decoder.write(captured);
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          collector.consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending.length > 65536) {
          state.toolError = "LINE_LIMIT";
          parserStopped = true;
          pending = "";
          child.kill();
        }
      }
      yield captured;
      if (captured.length !== chunk.length) return;
    }
    pending += decoder.end();
    if (pending && !parserStopped) collector.consume(pending);
  };
}

/** Preserve complete raw bytes compressed, while parsing bounded records. */
async function streamUnwind(tool, binary, output) {
  const args = ["--unwind", binary];
  const rawPath = path.join(output, "windows-pe-unwind.stdout.log.gz");
  const timeoutMs = Math.min(90_000, deadline - Date.now());
  if (timeoutMs <= 0)
    throw new Error("Windows unwind diagnostic deadline reached.");
  const child = spawn(tool, args, { windowsHide: true });
  const collector = windowsUnwindCollector();
  const state = { hash: createHash("sha256"), bytes: 0, toolError: null };
  let timedOut = false;
  let stderr = "";
  const stopped = new Promise((resolve) => {
    child.once("error", (error) => {
      state.toolError = error.code ?? error.message;
    });
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr) > 1024 * 1024) {
      state.toolError = "STDERR_LIMIT";
      child.kill();
      stderr = stderr.slice(0, 1024 * 1024);
    }
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const records = unwindRecords(child, collector, state);
  let captureError = null;
  try {
    await pipeline(
      child.stdout,
      records,
      createGzip(),
      createWriteStream(rawPath),
    );
  } catch (error) {
    captureError = error.message;
    child.kill();
  }
  const stoppedReceipt = await stopped;
  clearTimeout(timer);
  writeFileSync(path.join(output, "windows-pe-unwind.stderr.log"), stderr);
  return {
    summary: collector.finish(),
    receipt: {
      tool: path.basename(tool),
      args,
      ...stoppedReceipt,
      errorCode: state.toolError,
      timedOut,
      captureError,
      rawStdoutBytes: state.bytes,
      rawStdoutSha256: state.hash.digest("hex"),
      rawArchive: path.basename(rawPath),
      rawArchiveComplete: captureError === null,
      rawStdoutHashQualification: captureError
        ? "Bytes read for compression; archive may be incomplete"
        : "Exact decompressed archive bytes",
      rawArchiveSha256: await digest(rawPath),
      rawByteLimit: 512 * 1024 * 1024,
      timeoutMs,
    },
  };
}

async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

function llvmTools(output, host) {
  const sysroot = run(
    "rustc",
    ["+1.88.0", "--print", "sysroot"],
    output,
    "windows-stack-sysroot",
  );
  if (sysroot.receipt.status !== 0)
    throw new Error("Pinned native Rust sysroot lookup failed.");
  const root = path.join(sysroot.stdout.trim(), "lib", "rustlib", host, "bin");
  const tools = {};
  for (const name of ["llvm-readobj", "llvm-nm", "llvm-objdump"]) {
    const file = path.join(root, `${name}.exe`);
    if (!existsSync(file))
      throw new Error(`Pinned LLVM tool is unavailable: ${name}`);
    tools[name] = file;
  }
  return tools;
}

function disassemble(tools, binary, output, report, receipts) {
  let index = 0;
  let withInstructions = 0;
  const ranges = prologueRanges(report);
  for (const range of ranges) {
    if (Date.now() >= deadline) break;
    const result = run(
      tools["llvm-objdump"],
      [
        "--disassemble",
        "--demangle",
        "--no-show-raw-insn",
        `--start-address=${range.start}`,
        `--stop-address=${range.stop}`,
        binary,
      ],
      output,
      `windows-prologue-${index++}`,
    );
    const instructionLines = (result.stdout.match(/^\s*[0-9a-f]+:/gim) ?? [])
      .length;
    if (result.receipt.status === 0 && instructionLines) withInstructions++;
    receipts.push({ ...result.receipt, instructionLines });
    console.log(
      `Executable disassembly at ${range.start} (${instructionLines} instruction lines):\n${result.stdout}`,
    );
  }
  return { requested: ranges.length, attempted: index, withInstructions };
}

function assertCompleteUnwind(headers, unwind, report) {
  if (
    headers.receipt.status !== 0 ||
    unwind.receipt.status !== 0 ||
    unwind.receipt.errorCode ||
    unwind.receipt.captureError ||
    unwind.receipt.timedOut ||
    !report.pe.stackReserveBytes ||
    !report.unwindRecords ||
    !report.unwindComplete ||
    report.unwindRecords !== report.expectedUnwindRecords
  )
    throw new Error(
      "PE/unwind diagnostics are incomplete; raw bounded outputs are preserved.",
    );
}

async function main() {
  if (process.platform !== "win32")
    throw new Error("This diagnostic requires the actual Windows runner.");
  const host = environment("NATIVE_HOST_TARGET");
  if (host !== "x86_64-pc-windows-msvc")
    throw new Error("Unsupported native PE unwind format.");
  const output = environment("NATIVE_AUDIT_DIR");
  const binary = path.join(
    environment("CARGO_TARGET_DIR"),
    host,
    "debug",
    "opensesame.exe",
  );
  if (!statSync(binary).isFile())
    throw new Error("The actual tested CLI executable is missing.");
  const before = { bytes: statSync(binary).size, sha256: await digest(binary) };
  const tools = llvmTools(output, host);
  const receipts = [];
  for (const tool of Object.values(tools)) {
    const version = run(
      tool,
      ["--version"],
      output,
      `windows-${path.basename(tool, ".exe")}-version`,
    );
    receipts.push(version.receipt);
  }
  // An observer child records the active first-chance stack. This is a second
  // unchanged --version execution, not a replacement result for the failed gate.
  const observer = run(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fileURLToPath(
        new URL("./native-windows-startup-observer.ps1", import.meta.url),
      ),
      "-Binary",
      binary,
    ],
    output,
    "windows-startup-observer",
    60_000,
  );
  receipts.push(observer.receipt);
  console.log(
    `Second unchanged --version debugger observation:\n${observer.stdout}`,
  );
  const headers = run(
    tools["llvm-readobj"],
    ["--file-headers", "--codeview", binary],
    output,
    "windows-pe-headers",
  );
  const unwind = await streamUnwind(tools["llvm-readobj"], binary, output);
  const symbols = run(
    tools["llvm-nm"],
    ["--numeric-sort", "--demangle", "--defined-only", binary],
    output,
    "windows-symbols",
  );
  const report = windowsStackReport(
    headers.stdout,
    symbols.stdout,
    unwind.summary,
  );
  receipts.push(headers.receipt, unwind.receipt, symbols.receipt);
  console.log(JSON.stringify({ actualExecutable: before, ...report }, null, 2));
  const prologues = disassemble(tools, binary, output, report, receipts);
  const after = { bytes: statSync(binary).size, sha256: await digest(binary) };
  const result = {
    commit: environment("EXPECTED_HEAD"),
    host,
    binary,
    before,
    after,
    report,
    receipts,
    observer: observer.receipt,
    prologues,
  };
  writeFileSync(
    path.join(output, "windows-stack-report.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes)
    throw new Error("Executable changed during diagnostics.");
  assertCompleteUnwind(headers, unwind, report);
  if (!prologues.withInstructions)
    throw new Error(
      "Executable disassembly has no recorded instructions; raw bounded outputs are preserved.",
    );
}

await main();
