/** Numeric-only crash evidence; unavailable readings remain explicitly unknown. */
import { readFileSync, statfsSync } from "node:fs";

const UNKNOWN = "unknown";
const EVENTS = ["low", "high", "max", "oom", "oom_kill", "oom_group_kill"];
const CGROUP = "/sys/fs/cgroup/";

function counter(text) {
  const token = text?.trim() ?? "";
  if (!/^\d+$/.test(token)) return UNKNOWN;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : UNKNOWN;
}

function readCounter(readText, name) {
  try {
    return counter(readText(`${CGROUP}${name}`, "utf8"));
  } catch {
    return UNKNOWN;
  }
}

function events(readText) {
  let readings = [];
  try {
    readings = readText(`${CGROUP}memory.events`, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
  } catch {}
  return Object.fromEntries(
    EVENTS.map((name) => [
      name,
      counter(readings.find(([key]) => key === name)?.[1]),
    ]),
  );
}

function bytes(blocks, size) {
  const value = blocks * size;
  return blocks >= 0n && size > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : UNKNOWN;
}

/** Reads only fixed resource counters, never process arguments or environment. */
export function browserResourceSnapshot({
  readText = readFileSync,
  filesystem = statfsSync,
} = {}) {
  let sharedMemory = { totalBytes: UNKNOWN, availableBytes: UNKNOWN };
  try {
    const info = filesystem("/dev/shm", { bigint: true });
    sharedMemory = {
      totalBytes: bytes(info.blocks, info.bsize),
      availableBytes: bytes(info.bavail, info.bsize),
    };
  } catch {}
  return {
    memoryCurrentBytes: readCounter(readText, "memory.current"),
    memoryPeakBytes: readCounter(readText, "memory.peak"),
    memoryEvents: events(readText),
    sharedMemory,
  };
}

/** Preserve the original crash failure and attach only numeric resource evidence. */
export function crashResourceRecorder(record, describeCrash) {
  const before = browserResourceSnapshot();
  return (page) => {
    const atCrash = browserResourceSnapshot();
    record("PAGE-CRASH", describeCrash(page));
    record("PAGE-CRASH-RESOURCES", JSON.stringify({ before, atCrash }));
  };
}
