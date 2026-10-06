import {
  appendFile,
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  readSecurityFile,
  securityFilePorts,
  writeSecurityFile,
} from "./security-files.js";
it("writes once with owner-only permissions and rejects oversized, exposed, or symlinked files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-canary-files-"));
  try {
    const file = join(directory, "canary.json");
    await writeSecurityFile(file, { fixture: "controlled synthetic test" });
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readSecurityFile(file)).toContain("controlled synthetic test");
    await expect(writeSecurityFile(file, { replaced: true })).rejects.toThrow();
    expect(await readFile(file, "utf8")).not.toContain("replaced");
    await expect(readSecurityFile(file, 1)).rejects.toThrow();
    const link = join(directory, "link.json");
    await symlink(file, link);
    await expect(readSecurityFile(link)).rejects.toThrow();
    await chmod(file, 0o644);
    await expect(readSecurityFile(file)).rejects.toThrow(/owner-only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds the actual descriptor read when a private file grows after stat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "os-canary-growing-"));
  const file = join(directory, "growing.json");
  const original = securityFilePorts.open;
  let capacity = 0;
  try {
    await writeSecurityFile(file, { v: 1 });
    securityFilePorts.open = async (path, flags) => {
      const handle = await open(path, flags);
      const actualStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        const before = await actualStat();
        await appendFile(file, "x".repeat(65536));
        return before;
      });
      const actualRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (options) => {
        if (!options?.buffer)
          throw new Error("Expected bounded descriptor buffer");
        capacity = Math.max(capacity, options.buffer.byteLength);
        return actualRead(options);
      });
      return handle;
    };
    await expect(readSecurityFile(file, 64)).rejects.toThrow(/size limit/);
    expect(capacity).toBe(65);
    expect((await stat(file)).size).toBeGreaterThan(65536);
  } finally {
    securityFilePorts.open = original;
    await rm(directory, { recursive: true, force: true });
  }
});
