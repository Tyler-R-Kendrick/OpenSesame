import { spawnSync } from "node:child_process";
/** Failure-only inspection of the already tested executable, without rebuilding. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  prologueRanges,
  windowsStackReport,
} from "../lib/native-windows-stack-report.mjs";

const MAX_TOOL_BYTES = 32 * 1024 * 1024;
const deadline = Date.now() + 180_000;

function environment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing diagnostic input: ${name}`);
  return value;
}

function run(tool, args, output, label) {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new Error("Windows stack diagnostic deadline reached.");
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    maxBuffer: MAX_TOOL_BYTES,
    timeout: Math.min(30_000, remaining),
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
  const headers = run(
    tools["llvm-readobj"],
    ["--file-headers", "--unwind", "--symbols", "--codeview", binary],
    output,
    "windows-pe-unwind",
  );
  const symbols = run(
    tools["llvm-nm"],
    ["--numeric-sort", "--demangle", "--defined-only", binary],
    output,
    "windows-symbols",
  );
  const report = windowsStackReport(headers.stdout, symbols.stdout);
  receipts.push(headers.receipt, symbols.receipt);
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
    prologues,
  };
  writeFileSync(
    path.join(output, "windows-stack-report.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes)
    throw new Error("Executable changed during diagnostics.");
  if (
    headers.receipt.status !== 0 ||
    !report.pe.stackReserveBytes ||
    !report.unwindRecords
  )
    throw new Error(
      "PE/unwind diagnostics are incomplete; raw bounded outputs are preserved.",
    );
  if (!prologues.withInstructions)
    throw new Error(
      "Executable disassembly has no recorded instructions; raw bounded outputs are preserved.",
    );
}

await main();
