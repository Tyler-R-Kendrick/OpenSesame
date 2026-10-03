import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SEALED_LINE_PREFIX,
  SealedLogFile,
  openLogLine,
  sealExistingLog,
} from "../sealed-log.js";

const key = Uint8Array.from({ length: 32 }, () => 7);
const dir = () => mkdtempSync(join(tmpdir(), "sealed-log-shared-"));
/** A sealed 21-character line is 87 bytes with its newline: two fit under 200. */
const MAX = 200;
const LINE = "xxxxxxxxxxxxxxxxxxxx";

function opened(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => openLogLine(key, line) ?? "[unreadable]");
}

describe("several writers on one sealed log path", () => {
  it("never writes to a generation another process rotated away", () => {
    const log = join(dir(), "shared.log");
    const a = new SealedLogFile(log, key, { maxBytes: MAX, keep: 3 });
    const b = new SealedLogFile(log, key, { maxBytes: MAX, keep: 3 });
    a.append(`${LINE}1`);
    a.append(`${LINE}2`);
    a.append(`${LINE}3`);
    b.append("from b");
    expect(opened(log)).toEqual([`${LINE}3`, "from b"]);
    expect(opened(`${log}.1`)).toEqual([`${LINE}1`, `${LINE}2`]);
  });

  it("judges rotation on the real size, not a stale count", () => {
    const log = join(dir(), "shared.log");
    const a = new SealedLogFile(log, key, { maxBytes: MAX, keep: 3 });
    const b = new SealedLogFile(log, key, { maxBytes: MAX, keep: 3 });
    b.append(`${LINE}1`);
    b.append(`${LINE}2`);
    a.append(`${LINE}3`);
    b.append(`${LINE}4`);
    expect(opened(log)).toEqual([`${LINE}3`, `${LINE}4`]);
    expect(existsSync(`${log}.2`)).toBe(false);
  });

  it("recreates a removed file owner-only and never throws into the logger", () => {
    const folder = dir();
    const log = join(folder, "shared.log");
    const file = new SealedLogFile(log, key, { maxBytes: MAX, keep: 3 });
    file.append("before");
    const before = process.umask(0);
    try {
      rmSync(log);
      file.append("after");
      expect(statSync(log).mode & 0o777).toBe(0o600);
      expect(opened(log)).toEqual(["after"]);
      rmSync(folder, { recursive: true, force: true });
      expect(() => file.append("nowhere to go")).not.toThrow();
    } finally {
      process.umask(before);
    }
  });
});

describe("sealing what an older build left", () => {
  it("seals every rotated generation, scrubbed, owner-only and idempotently", () => {
    const log = join(dir(), "daemon.log");
    writeFileSync(log, "live line\n");
    writeFileSync(
      `${log}.1`,
      "older\nfailed: https://h.example/x#token=abc123\n",
    );
    writeFileSync(`${log}.2`, "oldest\n");
    expect(sealExistingLog(log, key)).toBe(4);
    for (const path of [log, `${log}.1`, `${log}.2`]) {
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toMatch(/line|older|abc123/);
      for (const line of raw.trim().split("\n")) {
        expect(line.startsWith(SEALED_LINE_PREFIX)).toBe(true);
      }
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(opened(`${log}.1`)[1]).not.toContain("abc123");
    expect(sealExistingLog(log, key)).toBe(0);
  });
});
