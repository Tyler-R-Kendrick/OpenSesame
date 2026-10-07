import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Native ESM evaluation, not a transpiler's module emulation. This tests module
// scheduling only; the actual owner/admission test exercises the security panel.
it("finishes entry evaluation before a lazy helper imports its codec bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "security-entry-esm-"));
  try {
    await writeFile(
      join(directory, "leaf.mjs"),
      'import { codec } from "./entry.mjs"; export const parsed = codec("ready");',
    );
    const entry = join(directory, "entry.mjs");
    const common = "export const codec = value => value;\n";
    await writeFile(
      entry,
      `${common}const leaf = await import("./leaf.mjs");\nconsole.log(leaf.parsed);`,
    );
    const blocked = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(blocked.error).toBeUndefined();
    expect(blocked.status).toBe(13);
    expect(blocked.stdout).not.toContain("ready");
    await writeFile(
      entry,
      `${common}let initialized;\nconst ready = import("./leaf.mjs").then(leaf => { initialized = leaf.parsed; });\nif (initialized !== undefined) throw Error("Premature readiness");\nvoid ready.then(() => console.log(initialized));`,
    );
    const completed = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(completed.error).toBeUndefined();
    expect(completed.status).toBe(0);
    expect(completed.stdout.trim()).toBe("ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
