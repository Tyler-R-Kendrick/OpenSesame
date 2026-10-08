import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const recordSchema = z.record(z.unknown());
const counterSchema = z.record(z.number().int().nonnegative());

export function coverageRuntimeRoots(packagePath) {
  if (
    packagePath === "apps/browser-extension" ||
    packagePath === "apps/browser-extension-autofill"
  ) {
    return ["src", "lib", "runner", "entrypoints"];
  }
  if (packagePath === "examples/static-rp") return ["src", "public"];
  return ["src"];
}

export function coverageIncludePatterns(packagePath) {
  return coverageRuntimeRoots(packagePath).map(
    (root) => `${root}/**/*.{ts,tsx}`,
  );
}

function runtimeSource(path) {
  return (
    /\.tsx?$/u.test(path) &&
    !/\.d\.ts$/u.test(path) &&
    !/\.(?:test|spec)\.tsx?$/u.test(path)
  );
}

export function runtimeSourceInventory(directory, packagePath) {
  const files = [];
  function walk(path) {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && runtimeSource(child)) files.push(child);
    }
  }
  for (const root of coverageRuntimeRoots(packagePath)) {
    walk(join(directory, root));
  }
  return files.sort();
}

function record(value) {
  return recordSchema.safeParse(value).success;
}

function counters(value) {
  return counterSchema.safeParse(value).success;
}

function instrumentedFile(file, packagePath) {
  if (!record(file) || !counters(file.s) || !counters(file.f)) {
    throw new Error(`Invalid runtime counters in ${packagePath} coverage.`);
  }
  return Object.keys(file.s).length > 0 || Object.keys(file.f).length > 0;
}

export function validateRuntimeCoverage(report, runtimeFiles, packagePath) {
  if (!record(report)) {
    throw new Error(`Invalid TypeScript coverage report for ${packagePath}.`);
  }
  const files = Object.values(report);
  if (runtimeFiles.length === 0 && files.length === 0) {
    return { applicable: false, reason: "No TypeScript runtime sources." };
  }
  const selected = new Set(
    runtimeFiles.map((path) => path.replaceAll("\\", "/")),
  );
  const instrumented = Object.entries(report)
    .filter(([path]) => selected.has(path.replaceAll("\\", "/")))
    .map(([, file]) => instrumentedFile(file, packagePath))
    .some(Boolean);
  if (!instrumented) {
    throw new Error(`No runtime instrumentation in ${packagePath} coverage.`);
  }
  return { applicable: true };
}
