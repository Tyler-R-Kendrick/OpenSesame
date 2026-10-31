import { describe, expect, it } from "vitest";
import {
  browserResourceSnapshot,
  crashResourceRecorder,
} from "./browser-resource-diagnostics.mjs";

const prefix = "/sys/fs/cgroup/";

describe("numeric browser crash evidence", () => {
  it("records actual zero counters and only the fixed cgroup and shared-memory inputs", () => {
    const reads = [];
    const files = new Map([
      [`${prefix}memory.current`, "1024\n"],
      [`${prefix}memory.peak`, "4096\n"],
      [
        `${prefix}memory.events`,
        "low 0\nhigh 2\nmax 3\noom 0\noom_kill 0\noom_group_kill 0\n",
      ],
    ]);
    const snapshot = browserResourceSnapshot({
      readText(path, encoding) {
        reads.push([path, encoding]);
        return files.get(path);
      },
      filesystem(path, options) {
        expect(path).toBe("/dev/shm");
        expect(options).toEqual({ bigint: true });
        return { blocks: 16n, bavail: 4n, bsize: 4096n };
      },
    });
    expect(reads).toEqual([...files.keys()].map((path) => [path, "utf8"]));
    expect(snapshot).toEqual({
      memoryCurrentBytes: 1024,
      memoryPeakBytes: 4096,
      memoryEvents: {
        low: 0,
        high: 2,
        max: 3,
        oom: 0,
        oom_kill: 0,
        oom_group_kill: 0,
      },
      sharedMemory: { totalBytes: 65536, availableBytes: 16384 },
    });
  });

  it("keeps missing or inaccessible readings unknown and never emits the failure text", () => {
    const unavailable = () => {
      throw new Error("private filesystem detail");
    };
    const snapshot = browserResourceSnapshot({
      readText: unavailable,
      filesystem: unavailable,
    });
    expect(snapshot).toEqual({
      memoryCurrentBytes: "unknown",
      memoryPeakBytes: "unknown",
      memoryEvents: {
        low: "unknown",
        high: "unknown",
        max: "unknown",
        oom: "unknown",
        oom_kill: "unknown",
        oom_group_kill: "unknown",
      },
      sharedMemory: { totalBytes: "unknown", availableBytes: "unknown" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("excludes arbitrary event fields and rejects malformed or imprecise numeric readings", () => {
    const snapshot = browserResourceSnapshot({
      readText(path) {
        if (path.endsWith("memory.events"))
          return "oom invalid\nprivate secret\nmax 9007199254740992\n";
        return "secret-value";
      },
      filesystem: () => ({
        blocks: 9007199254740992n,
        bavail: -1n,
        bsize: 4096n,
      }),
    });
    expect(snapshot.memoryCurrentBytes).toBe("unknown");
    expect(snapshot.memoryPeakBytes).toBe("unknown");
    expect(Object.values(snapshot.memoryEvents)).toEqual(
      Array(6).fill("unknown"),
    );
    expect(snapshot.sharedMemory).toEqual({
      totalBytes: "unknown",
      availableBytes: "unknown",
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /secret|private|9007199254740992/,
    );
  });
});

describe("page crash resource recording", () => {
  it("retains the crash failure and records before/at-crash snapshots only when invoked", () => {
    const entries = [];
    const crash = crashResourceRecorder(
      (...entry) => entries.push(entry),
      () => "webkit fixture",
    );
    expect(entries).toEqual([]);
    crash({});
    expect(entries[0]).toEqual(["PAGE-CRASH", "webkit fixture"]);
    expect(entries[1][0]).toBe("PAGE-CRASH-RESOURCES");
    const evidence = JSON.parse(entries[1][1]);
    expect(Object.keys(evidence)).toEqual(["before", "atCrash"]);
    for (const snapshot of Object.values(evidence)) {
      const values = [
        snapshot.memoryCurrentBytes,
        snapshot.memoryPeakBytes,
        ...Object.values(snapshot.memoryEvents),
        ...Object.values(snapshot.sharedMemory),
      ];
      for (const value of values)
        expect(
          value === "unknown" || (Number.isSafeInteger(value) && value >= 0),
        ).toBe(true);
    }
  });
});
