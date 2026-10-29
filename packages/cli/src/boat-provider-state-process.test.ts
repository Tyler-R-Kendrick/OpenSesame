import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withBoatStateLock } from "./boat-provider-state.js";

it("excludes another process and requires explicit recovery after a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boat-state-process-"));
  const moduleUrl = new URL("./boat-provider-state.ts", import.meta.url).href;
  const source = `import { writeFileSync } from "node:fs";
import { withBoatStateLock } from ${JSON.stringify(moduleUrl)};
await withBoatStateLock(process.argv[1], async () => {
  writeFileSync(process.argv[2], "ready");
  await new Promise(() => setInterval(() => {}, 1000));
});`;
  const ready = join(dir, "ready");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, dir, ready],
    {
      stdio: "ignore",
    },
  );
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("child exited before acquiring lock");
      if (Date.now() >= deadline) throw new Error("child lock timeout");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await expect(withBoatStateLock(dir, async () => {})).rejects.toThrow(
      /locked/,
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    await expect(withBoatStateLock(dir, async () => {})).rejects.toThrow(
      /locked/,
    );
    unlinkSync(join(dir, ".boat-agent-state.lock"));
    await withBoatStateLock(dir, async () => {});
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
