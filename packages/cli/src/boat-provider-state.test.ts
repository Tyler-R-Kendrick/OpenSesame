import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBoatProviderState,
  saveBoatProviderState,
  withBoatStateLock,
} from "./boat-provider-state.js";

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "boat-private-state-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("Boat registration state storage", () => {
  it("creates and atomically replaces a private state file", () => {
    const dir = directory();
    expect(loadBoatProviderState(dir)).toEqual({});
    saveBoatProviderState(dir, { claimToken: "first" });
    expect(lstatSync(join(dir, ".boat-agent-state.json")).mode & 0o777).toBe(
      0o600,
    );
    const state = {
      claimToken: "second",
      identityAssertion: "assertion",
      claimMaterials: {
        claimToken: "second",
        userCode: "123456",
        verificationUri: "https://boat.dev/claim?token=one",
        expiresIn: 600,
        interval: 5,
      },
    };
    saveBoatProviderState(dir, state);
    expect(loadBoatProviderState(dir)).toEqual(state);
  });

  it("refuses existing world-readable credentials without overwriting them", () => {
    const dir = directory();
    const path = join(dir, ".boat-agent-state.json");
    writeFileSync(path, '{"claimToken":"old"}', { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => loadBoatProviderState(dir)).toThrow(/private 0600/);
    expect(() => saveBoatProviderState(dir, { claimToken: "new" })).toThrow(
      /private 0600/,
    );
    expect(readFileSync(path, "utf8")).toBe('{"claimToken":"old"}');
  });

  it("rejects symlinked state without reading or replacing its target", () => {
    const dir = directory();
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched", { mode: 0o600 });
    symlinkSync(victim, join(dir, ".boat-agent-state.json"));
    expect(() => loadBoatProviderState(dir)).toThrow();
    expect(() =>
      saveBoatProviderState(dir, { claimToken: "secret" }),
    ).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });

  it("rejects a hard-linked state file without altering either name", () => {
    const dir = directory();
    const original = join(dir, "original");
    writeFileSync(original, '{"claimToken":"old"}', { mode: 0o600 });
    linkSync(original, join(dir, ".boat-agent-state.json"));
    expect(() => loadBoatProviderState(dir)).toThrow(/private 0600/);
    expect(() => saveBoatProviderState(dir, { claimToken: "new" })).toThrow(
      /private 0600/,
    );
    expect(readFileSync(original, "utf8")).toBe('{"claimToken":"old"}');
  });

  it("rejects a FIFO immediately without waiting for a writer", () => {
    const dir = directory();
    const path = join(dir, ".boat-agent-state.json");
    const result = spawnSync("mkfifo", [path], {
      stdio: "ignore",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(() => loadBoatProviderState(dir)).toThrow(/private 0600/);
  });

  it("rejects oversized encoded state before replacing valid credentials", () => {
    const dir = directory();
    saveBoatProviderState(dir, { claimToken: "safe" });
    const path = join(dir, ".boat-agent-state.json");
    expect(() =>
      saveBoatProviderState(dir, {
        claimToken: "\u0001".repeat(32768),
        identityAssertion: "\u0002".repeat(32768),
      }),
    ).toThrow(/maximum encoded size/);
    expect(loadBoatProviderState(dir)).toEqual({ claimToken: "safe" });
    expect(readFileSync(path, "utf8")).toContain("safe");
  });

  it("rejects a writable shared directory", () => {
    const dir = directory();
    chmodSync(dir, 0o777);
    expect(() => saveBoatProviderState(dir, { claimToken: "secret" })).toThrow(
      /directory/,
    );
  });

  it("rejects a writable non-sticky ancestor", () => {
    const dir = directory();
    const child = join(dir, "child");
    mkdirSync(child, { mode: 0o700 });
    chmodSync(dir, 0o777);
    try {
      expect(() =>
        saveBoatProviderState(child, { claimToken: "secret" }),
      ).toThrow(/ancestor/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("serializes allocations and preserves an existing lock", async () => {
    const dir = directory();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withBoatStateLock(dir, async () => {
      saveBoatProviderState(dir, { claimToken: "first" });
      await gate;
    });
    await expect(withBoatStateLock(dir, async () => {})).rejects.toThrow(
      /locked/,
    );
    expect(loadBoatProviderState(dir)).toEqual({ claimToken: "first" });
    release?.();
    await first;
    await withBoatStateLock(dir, async () =>
      saveBoatProviderState(dir, { claimToken: "next" }),
    );
    expect(loadBoatProviderState(dir)).toEqual({ claimToken: "next" });
    writeFileSync(join(dir, ".boat-agent-state.lock"), "existing", {
      mode: 0o600,
    });
    await expect(withBoatStateLock(dir, async () => {})).rejects.toThrow(
      /locked/,
    );
    expect(readFileSync(join(dir, ".boat-agent-state.lock"), "utf8")).toBe(
      "existing",
    );
    unlinkSync(join(dir, ".boat-agent-state.lock"));
  });
});
