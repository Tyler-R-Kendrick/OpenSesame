import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import vectors from "../../../../spec/conformance/sealed-log-vectors.json" with {
  type: "json",
};
import { createLogger } from "../logger.js";
import {
  SEALED_LINE_PREFIX,
  SealedLogFile,
  UNREADABLE,
  createSealedLogDestination,
  loadLogKey,
  loadOrCreateLogKey,
  logKeyPath,
  openLogLine,
  readSealedTail,
  sealExistingLog,
  sealLogLine,
} from "../sealed-log.js";

const key = Uint8Array.from({ length: 32 }, () => 7);
const dir = () => mkdtempSync(join(tmpdir(), "sealed-log-"));

afterEach(() => {
  // biome-ignore lint/performance/noDelete: an env var must be absent, not "undefined"
  delete process.env.OPENSESAME_LOG_FILE;
  // biome-ignore lint/performance/noDelete: as above
  delete process.env.OPENSESAME_LOG_KEY_FILE;
});

describe("a sealed line", () => {
  it("round-trips and shows nothing", () => {
    const sealed = sealLogLine(key, "claim opened for ada@example.com");
    expect(sealed.startsWith(SEALED_LINE_PREFIX)).toBe(true);
    expect(sealed).not.toMatch(/ada|claim/);
    expect(openLogLine(key, sealed)).toBe("claim opened for ada@example.com");
    expect(sealLogLine(key, "same")).not.toBe(sealLogLine(key, "same"));
  });

  it("does not open under another key, torn, altered or unsealed", () => {
    const sealed = sealLogLine(key, "line");
    expect(
      openLogLine(
        Uint8Array.from({ length: 32 }, () => 8),
        sealed,
      ),
    ).toBeNull();
    expect(openLogLine(key, sealed.slice(0, -6))).toBeNull();
    const at = 10;
    const altered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;
    expect(openLogLine(key, altered)).toBeNull();
    expect(openLogLine(key, "plain text")).toBeNull();
    expect(openLogLine(key, SEALED_LINE_PREFIX)).toBeNull();
  });
});

describe("the key file", () => {
  it("is created once, owner-only, and reloaded", () => {
    const path = join(dir(), "nested", "log.key");
    const first = loadOrCreateLogKey(path);
    expect(loadOrCreateLogKey(path)).toEqual(first);
    expect(loadLogKey(path)).toEqual(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("is never overwritten when it holds no key", () => {
    const path = join(dir(), "log.key");
    writeFileSync(path, "not a key\n");
    expect(() => loadOrCreateLogKey(path)).toThrow(/32-byte hex/);
    expect(readFileSync(path, "utf8")).toBe("not a key\n");
  });

  it("defaults beside the log and can be pointed elsewhere", () => {
    expect(logKeyPath("/var/log/x.log")).toBe("/var/log/x.log.key");
    expect(logKeyPath("/var/log/x.log", "/run/secrets/k")).toBe(
      "/run/secrets/k",
    );
  });
});

describe("the sealed file", () => {
  it("holds only sealed lines, owner-only, and reads back", () => {
    const log = join(dir(), "svc.log");
    const file = new SealedLogFile(log, key);
    file.append("first line");
    file.append("second line\n");
    const raw = readFileSync(log, "utf8");
    expect(raw).not.toMatch(/first|second/);
    expect(
      raw
        .trim()
        .split("\n")
        .every((l) => l.startsWith(SEALED_LINE_PREFIX)),
    ).toBe(true);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    expect(readSealedTail(log, key, 10)).toEqual(["first line", "second line"]);
    expect(readSealedTail(log, key, 1)).toEqual(["second line"]);
    expect(
      readSealedTail(
        log,
        Uint8Array.from({ length: 32 }, () => 9),
        5,
      ),
    ).toEqual([UNREADABLE, UNREADABLE]);
  });

  it("narrows a file an older build left wide open", () => {
    const log = join(dir(), "svc.log");
    writeFileSync(log, "");
    chmodSync(log, 0o644);
    new SealedLogFile(log, key);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("rotates whole files and keeps a bounded number", () => {
    const log = join(dir(), "rot.log");
    const file = new SealedLogFile(log, key, { maxBytes: 400, keep: 2 });
    for (let n = 0; n < 40; n += 1)
      file.append(`event number ${n} with some padding text`);
    expect(existsSync(`${log}.1`) && existsSync(`${log}.2`)).toBe(true);
    expect(existsSync(`${log}.3`)).toBe(false);
    for (const path of [log, `${log}.1`, `${log}.2`]) {
      for (const line of readFileSync(path, "utf8").trim().split("\n")) {
        expect(openLogLine(key, line)).not.toBeNull();
      }
    }
    expect(readSealedTail(log, key, 1)).toEqual([
      "event number 39 with some padding text",
    ]);
  });

  it("seals a plaintext log in place, scrubbed on the way", () => {
    const log = join(dir(), "svc.log");
    writeFileSync(
      log,
      "started ok\nfailed: https://h.example/x#token=abc123\n",
    );
    expect(sealExistingLog(log, key)).toBe(2);
    expect(readFileSync(log, "utf8")).not.toMatch(/started|abc123/);
    const lines = readSealedTail(log, key, 5);
    expect(lines[0]).toBe("started ok");
    expect(lines[1]).not.toContain("abc123");
    expect(sealExistingLog(log, key)).toBe(0);
  });
});

describe("createLogger with OPENSESAME_LOG_FILE (ADR 0150)", () => {
  it("seals what it logs, scrubbed, and writes nothing in the clear", () => {
    const log = join(dir(), "svc.log");
    process.env.OPENSESAME_LOG_FILE = log;
    const logger = createLogger({ name: "sealed-test", level: "info" });
    logger.info({ user: "ada" }, "vault unlocked");
    logger.error(
      { password: "hunter2" },
      "failed: https://a.example/claim#token=osc_clm_AbC.s3cr3tpart",
    );

    const raw = readFileSync(log, "utf8");
    for (const shown of [
      "vault unlocked",
      "ada",
      "hunter2",
      "osc_clm_",
      "s3cr3tpart",
    ]) {
      expect(raw).not.toContain(shown);
    }
    const read = readSealedTail(log, loadLogKey(`${log}.key`), 10).join("\n");
    expect(read).toContain("vault unlocked");
    expect(read).toMatch(/failed/);
    for (const leaked of ["hunter2", "osc_clm_", "s3cr3tpart"]) {
      expect(read).not.toContain(leaked);
    }
  });

  it("refuses rather than log into the clear when the file cannot be opened", () => {
    expect(() =>
      createSealedLogDestination(join(dir(), "log.key-is-a-dir"), join(dir())),
    ).toThrow();
  });
});

describe("the format is one definition (spec/conformance/sealed-log-vectors.json)", () => {
  const vectorKey = Uint8Array.from(Buffer.from(vectors.key, "hex"));

  it.each(vectors.lines)(
    "opens a line the other implementation sealed: $plain",
    (vector) => {
      expect(openLogLine(vectorKey, vector.sealed)).toBe(vector.plain);
    },
  );

  it.each(vectors.notOpening)("refuses: $why", (refusal) => {
    expect(openLogLine(vectorKey, refusal.line)).toBeNull();
  });

  it("seals lines the other implementation can open (same envelope shape)", () => {
    for (const vector of vectors.lines) {
      const sealed = sealLogLine(vectorKey, vector.plain);
      expect(sealed.startsWith(SEALED_LINE_PREFIX)).toBe(true);
      expect(
        Buffer.from(sealed.slice(SEALED_LINE_PREFIX.length), "base64url")
          .length,
      ).toBe(
        Buffer.from(vector.sealed.slice(SEALED_LINE_PREFIX.length), "base64url")
          .length,
      );
      expect(openLogLine(vectorKey, sealed)).toBe(vector.plain);
    }
  });
});
