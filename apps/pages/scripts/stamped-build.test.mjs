import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stamp } from "./stamped-build.mjs";

const script = path.resolve(import.meta.dirname, "stamped-build.mjs");
const DEFAULT = `${JSON.stringify(
  {
    version: 1,
    profile: "shared_origin_demo",
    canonicalOrigin: "https://tyler-r-kendrick.github.io",
    headerSecurity: false,
  },
  null,
  2,
)}\n`;

function tracked() {
  const file = path.join(
    mkdtempSync(path.join(os.tmpdir(), "stamped-")),
    "security-profile.json",
  );
  writeFileSync(file, DEFAULT);
  return file;
}

const run = (command, file) =>
  spawnSync("node", [script, command], {
    encoding: "utf8",
    env: {
      ...process.env,
      PAGES_DEPLOYMENT_PROFILE: "loopback_development",
      PAGES_CANONICAL_ORIGIN: "http://localhost:41877",
      STAMP_PROFILE_FILE: file,
    },
  });

describe("stamped-build", () => {
  it("stamps the profile for the command and puts the tracked file back", () => {
    const file = tracked();
    const seen = run(`cat "${file}"`, file);
    expect(seen.status).toBe(0);
    expect(JSON.parse(seen.stdout)).toMatchObject({
      profile: "loopback_development",
      canonicalOrigin: "http://localhost:41877",
    });
    expect(readFileSync(file, "utf8")).toBe(DEFAULT);
  });

  it("puts it back when the build fails, with the build's own exit code", () => {
    const file = tracked();
    const failed = run("exit 3", file);
    expect(failed.status).toBe(3);
    expect(readFileSync(file, "utf8")).toBe(DEFAULT);
  });

  it("puts it back when a step in the middle of a chain fails", () => {
    const file = tracked();
    const failed = run(
      `cat "${file}" > /dev/null && false && echo never`,
      file,
    );
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).not.toMatch(/never/);
    expect(readFileSync(file, "utf8")).toBe(DEFAULT);
  });

  it("restores once", () => {
    const file = tracked();
    const restore = stamp(file, { version: 1, profile: "x" });
    expect(readFileSync(file, "utf8")).toMatch(/"profile": "x"/);
    restore();
    expect(readFileSync(file, "utf8")).toBe(DEFAULT);
    writeFileSync(file, "changed after\n");
    restore();
    expect(readFileSync(file, "utf8")).toBe("changed after\n");
  });

  it("does not mistake a file a crashed run left stamped for the original", () => {
    const file = tracked();
    stamp(file, { version: 1, profile: "loopback_development" });
    const seen = run(`cat "${file}"`, file);
    expect(seen.status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(DEFAULT);
  });

  it("refuses an invalid profile before touching the file", () => {
    const file = tracked();
    const refused = spawnSync("node", [script, "true"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PAGES_DEPLOYMENT_PROFILE: "nonsense",
        STAMP_PROFILE_FILE: file,
      },
    });
    expect(refused.status).not.toBe(0);
    expect(readFileSync(file, "utf8")).toBe(DEFAULT);
  });
});
