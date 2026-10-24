// kit-archive.sh sums (ADR 0212): the bridge published on its own is the one
// inside every kit, checked when the sums are written.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const script = join(repoRootFromHere(), "scripts/release/kit-archive.sh");
const TEST_BUILD = "opensesame-surrogate-proxy-TEST-upstream-override";
const gnuTar = /GNU tar/.test(
  spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "",
);

describe.skipIf(!gnuTar)("kit-archive.sh sums", () => {
  let work;
  let out;
  const env = { ...process.env, SOURCE_DATE_EPOCH: "1760000000" };
  const sums = () =>
    spawnSync("bash", [script, "sums", out], { env, encoding: "utf8" });

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "kit-sums-"));
    const bins = join(work, "bins");
    mkdirSync(bins);
    const bin = (name, text) => {
      writeFileSync(join(bins, name), text);
      chmodSync(join(bins, name), 0o755);
    };
    bin("opensesame", "stand-in for opensesame\n");
    bin("opensesame-surrogate-proxy", "plugin_not_active\n");
    bin(TEST_BUILD, "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
    const bridge = join(work, "opensesame-env-parse.mjs");
    writeFileSync(bridge, "#!/usr/bin/env node\n// the bridge\n");
    out = join(work, "out");
    const packed = spawnSync(
      "bash",
      [script, "pack", "v0.1.0", "x86_64-unknown-linux-gnu", bins, bridge, out],
      { env, encoding: "utf8" },
    );
    expect(packed.status).toBe(0);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("writes the sums when the bridge on its own is the one in the kit", () => {
    writeFileSync(
      join(out, "opensesame-env-parse.mjs"),
      "#!/usr/bin/env node\n// the bridge\n",
    );
    const run = sums();
    expect({ status: run.status, err: run.stderr }).toEqual({
      status: 0,
      err: "",
    });
    expect(run.stdout).toContain("opensesame-env-parse.mjs");
  });

  it("refuses a bridge that is not the one inside the kit, naming both digests", () => {
    writeFileSync(join(out, "opensesame-env-parse.mjs"), "// another bridge\n");
    const run = sums();
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(
      /opensesame-kit_v0\.1\.0_x86_64-unknown-linux-gnu\.tar\.gz holds an opensesame-env-parse\.mjs \([0-9a-f]{64}\) that is not the one on its own \([0-9a-f]{64}\)/,
    );
  });
});
