import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./run.js";

const TOUCHED_ENV = ["OPENSESAME_STATE_DIR"] as const;

let out = "";
let err = "";

function captureStreams() {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "opensesame-cli-cmd-"));
  process.env.OPENSESAME_STATE_DIR = dir;
  out = "";
  err = "";
  captureStreams();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of TOUCHED_ENV) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe("runCli — help and parse failures", () => {
  it("prints help and exits 0", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(out).toContain("opensesame-id");
  });

  it("reports an unknown command on stderr and exits 1", async () => {
    expect(await runCli(["frobnicate"])).toBe(1);
    expect(err).toMatch(/Unknown command: frobnicate/);
  });

  it("reports removed Host/Identity commands as unknown", async () => {
    expect(await runCli(["login", "--device"])).toBe(1);
    expect(err).toMatch(/Unknown command: login/);
  });
});
