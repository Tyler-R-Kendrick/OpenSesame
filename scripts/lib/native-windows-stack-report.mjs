/** Summarize actual LLVM output; raw records remain the diagnostic authority. */
const STARTUP_GROUPS = [
  /^(?:main|mainCRTStartup|__scrt_common_main_seh)$/,
  /opensesame::main(?:::|$)/,
  /opensesame::real_main(?:::|$)/,
  /opensesame::entry_dispatch::run(?:::|$)/,
  /opensesame::entry::by_program_name(?:::|$)/,
  /opensesame::session::verb(?:::|$)/,
  /<opensesame::Cli .*CommandFactory.*>::command(?:::|$)/,
  /clap_builder::derive::Parser::(?:parse_from|try_parse_from)(?:::|$)/,
  /<opensesame::Cli\b/,
  /<opensesame::Commands\b/,
  /opensesame::entry::/,
  /opensesame::session::enter(?:::|$)/,
];

function numberField(text, name) {
  const match = new RegExp(
    `^\\s*${name}:\\s*(0x[0-9a-f]+|[0-9]+)\\b`,
    "im",
  ).exec(text);
  return match ? BigInt(match[1]).toString() : null;
}

function address(text) {
  const matches = [...text.matchAll(/0x[0-9a-f]+/gi)];
  return matches.at(-1)?.[0] ?? null;
}

function imageAddress(value, pe) {
  if (!value || !pe.imageBase || !pe.imageBytes) return null;
  const raw = BigInt(value);
  const base = BigInt(pe.imageBase);
  const bytes = BigInt(pe.imageBytes);
  if (raw < bytes) return `0x${(base + raw).toString(16)}`;
  if (raw >= base && raw < base + bytes) return `0x${raw.toString(16)}`;
  return null;
}

function recordLine(frame, line, depth) {
  if (depth === 1 && /StartAddress:/.test(line)) frame.start = address(line);
  if (depth === 1 && /EndAddress:/.test(line)) frame.end = address(line);
  if (/ChainInfo/i.test(line)) frame.chained = true;
  const reserve = /ALLOC_(?:SMALL|LARGE).*?size=(0x[0-9a-f]+|[0-9]+)/i.exec(
    line,
  );
  if (reserve) frame.explicitReserveBytes += Number(BigInt(reserve[1]));
  if (/PUSH_NONVOL/.test(line)) frame.savedRegisterPushBytes += 8;
  if (/ALLOC_|PUSH_|SET_FPREG|SAVE_/.test(line)) frame.codes.push(line.trim());
}

function unwindFrames(raw) {
  const frames = [];
  let depth = 0;
  let frame = null;
  for (const line of raw.split("\n")) {
    if (!frame && /^\s*RuntimeFunction\s*\{/.test(line)) {
      frame = {
        start: null,
        end: null,
        explicitReserveBytes: 0,
        savedRegisterPushBytes: 0,
        chained: false,
        codes: [],
      };
      depth = 0;
    }
    if (!frame) continue;
    recordLine(frame, line, depth);
    depth +=
      (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0) {
      frames.push(frame);
      frame = null;
    }
  }
  return frames;
}

function namedStartup(raw, pe) {
  const symbols = [];
  for (const line of raw.split("\n")) {
    const symbol = /^\s*([0-9a-f]+)\s+[Tt]\s+(.+)$/i.exec(line);
    if (!symbol) continue;
    const start = imageAddress(`0x${symbol[1]}`, pe);
    if (start) symbols.push({ start, name: symbol[2] });
  }
  const result = [];
  const seen = new Set();
  for (const pattern of STARTUP_GROUPS) {
    const selected = symbols
      .filter((entry) => pattern.test(entry.name))
      .slice(0, 3);
    for (const entry of selected) {
      const id = `${entry.start}:${entry.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(entry);
    }
  }
  return result;
}

export function windowsStackReport(headersAndUnwind, symbols) {
  const pe = {
    imageBase: numberField(headersAndUnwind, "ImageBase"),
    imageBytes: numberField(headersAndUnwind, "SizeOfImage"),
    entryPoint: numberField(headersAndUnwind, "AddressOfEntryPoint"),
    stackReserveBytes: numberField(headersAndUnwind, "SizeOfStackReserve"),
    stackCommitBytes: numberField(headersAndUnwind, "SizeOfStackCommit"),
  };
  const frames = unwindFrames(headersAndUnwind).map((frame) => ({
    ...frame,
    imageStart: imageAddress(frame.start, pe),
    imageEnd: imageAddress(frame.end, pe),
  }));
  const largest = frames
    .filter((frame) => !frame.chained)
    .sort((a, b) => b.explicitReserveBytes - a.explicitReserveBytes)
    .slice(0, 20);
  const startup = namedStartup(symbols, pe);
  return {
    pe,
    unwindRecords: frames.length,
    largest,
    startup,
    symbolQualification: startup.length
      ? "Actual executable symbol names"
      : "No matching executable symbols; no source-name mapping is inferred",
    allocationQualification:
      "Explicit unwind allocations and saved-register pushes only; chained records, dynamic allocations and combined caller/callee stack use require raw-record review",
  };
}

export function prologueRanges(report) {
  const starts = new Set([
    imageAddress(report.pe.entryPoint, report.pe),
    ...report.startup.map((entry) => entry.start),
    ...report.largest.slice(0, 8).map((entry) => entry.imageStart),
  ]);
  return [...starts].filter(Boolean).map((start) => ({
    start,
    stop: `0x${(BigInt(start) + 192n).toString(16)}`,
  }));
}
