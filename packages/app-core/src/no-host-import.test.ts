/**
 * Loading the core touches no port (ADR 0133 §3). Every module is imported
 * fresh with no host installed; one that reads a port while it loads — a
 * singleton whose constructor opens storage or a channel — throws here, as
 * it would in the browser before the shell's boot installs the host.
 */
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { host } from "./host.js";

const here = dirname(fileURLToPath(import.meta.url));
const SKIP =
  /(\.test\.ts|\.fixture\.ts|\.worker\.ts|\.d\.ts)$|\/(__tests__|doubles|test|node|sandbox)\/|\/test-[\w-]+\.ts$/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !SKIP.test(full) ? [full] : [];
  });
}

let installed: ReturnType<typeof host>;

beforeAll(() => {
  installed = host();
  globalThis.__opensesameAppCoreHost = undefined;
  vi.resetModules();
});

afterAll(() => {
  globalThis.__opensesameAppCoreHost = installed;
});

describe("importing the core with no host installed", () => {
  it("loads every module without reading a port", async () => {
    const failures: string[] = [];
    for (const path of sources(here)) {
      try {
        await import(pathToFileURL(path).href);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("no host installed"))
          failures.push(relative(here, path));
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
