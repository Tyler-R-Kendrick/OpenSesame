import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCredentialHelper } from "./parity-node.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await chmod(path, 0o700);
}

describe("resolveCredentialHelper", () => {
  it("uses the screened PATH from the caller environment, not a prepended hijack", async () => {
    const root = await mkdtemp(join(tmpdir(), "helper-path-env-"));
    directories.push(root);
    const trusted = join(root, "trusted");
    const hijack = join(root, "hijack");
    await mkdir(trusted);
    await mkdir(hijack);
    const marker = join(root, "marker");
    await writeExecutable(
      join(hijack, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`,
    );
    await writeExecutable(
      join(trusted, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeSync(1,'trusted');`,
    );
    const original = process.env.PATH;
    try {
      process.env.PATH = `${hijack}:${trusted}`;
      const resolved = resolveCredentialHelper("op", { PATH: trusted });
      expect(resolved).toBe(join(trusted, "op"));
      await expect(
        import("node:fs/promises").then((fs) => fs.readFile(marker)),
      ).rejects.toThrow();
    } finally {
      process.env.PATH = original;
    }
  });

  it("prefers the later trusted helper when an earlier PATH entry is also trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "helper-path-order-"));
    directories.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    await writeExecutable(
      join(first, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeSync(1,'first');`,
    );
    await writeExecutable(
      join(second, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeSync(1,'second');`,
    );
    const outer = await mkdtemp(join(tmpdir(), "helper-path-order-cwd-"));
    directories.push(outer);
    const original = process.env.PATH;
    const originalCwd = process.cwd();
    try {
      process.chdir(outer);
      process.env.PATH = `${first}:${second}`;
      expect(resolveCredentialHelper("op")).toBe(join(second, "op"));
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = original;
    }
  });

  it("rejects PATH directories that enclose the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "helper-path-parent-"));
    directories.push(root);
    const nested = join(root, "nested");
    await mkdir(nested);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeExecutable(
      join(bin, "op"),
      `#!${process.execPath}\nrequire('node:fs').writeSync(1,'ok');`,
    );
    const original = process.env.PATH;
    const originalCwd = process.cwd();
    try {
      process.chdir(nested);
      process.env.PATH = `${root}:${bin}`;
      expect(resolveCredentialHelper("op")).toBe(join(bin, "op"));
    } finally {
      process.chdir(originalCwd);
      process.env.PATH = original;
    }
  });
});
