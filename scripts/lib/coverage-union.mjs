import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const startPosition = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().nonnegative(),
  })
  .passthrough();
const endPosition = startPosition.extend({
  // Native source-map infinity is serialized as null by the JSON reporter.
  column: z.number().int().nonnegative().nullable(),
});
const location = z
  .object({ start: startPosition, end: endPosition })
  .passthrough();
// The pinned native converter emits this exact location for an implicit else.
const implicitBranch = z
  .object({ start: z.object({}).strict(), end: z.object({}).strict() })
  .strict();
const counter = z.number().int().nonnegative();
const ids = z.string().regex(/^\d+$/u);
const coverageSchema = z
  .object({
    path: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    statementMap: z.record(ids, location),
    fnMap: z.record(
      ids,
      z
        .object({ name: z.string(), decl: location, loc: location })
        .passthrough(),
    ),
    branchMap: z.record(
      ids,
      z
        .object({
          type: z.string(),
          loc: location,
          locations: z.array(z.union([location, implicitBranch])),
        })
        .passthrough(),
    ),
    s: z.record(ids, counter),
    f: z.record(ids, counter),
    b: z.record(ids, z.array(counter)),
  })
  .passthrough();
const reportSchema = z.record(z.unknown());

function sameKeys(left, right) {
  return isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort());
}

function validateCounterMaps(file) {
  for (const [map, counts] of [
    [file.statementMap, file.s],
    [file.fnMap, file.f],
    [file.branchMap, file.b],
  ]) {
    if (!sameKeys(map, counts))
      throw new Error("Native coverage counter keys do not match their maps.");
  }
  for (const [id, hits] of Object.entries(file.b)) {
    if (hits.length !== file.branchMap[id].locations.length) {
      throw new Error(
        "Native branch coverage dimensions do not match their maps.",
      );
    }
  }
}

function readCoverage(path, raw, inventory) {
  if (!isAbsolute(path))
    throw new Error("Coverage file identity must be absolute.");
  const key = resolve(path).replaceAll("\\", "/");
  const expected = inventory.get(key);
  const parsed = coverageSchema.safeParse(raw);
  if (!parsed.success || expected === undefined)
    throw new Error("Invalid or foreign native runtime coverage.");
  const file = parsed.data;
  if (
    !isAbsolute(file.path) ||
    resolve(file.path).replaceAll("\\", "/") !== key ||
    file.sourceSha256 !== expected
  ) {
    throw new Error(
      "Native coverage source identity does not match the workspace.",
    );
  }
  validateCounterMaps(file);
  return { key, file };
}

function mergeFile(previous, next) {
  for (const map of ["statementMap", "fnMap", "branchMap"]) {
    if (!isDeepStrictEqual(previous[map], next[map])) {
      throw new Error(
        "Incompatible native coverage source maps; refusing to invent a union.",
      );
    }
  }
  for (const kind of ["s", "f"]) {
    for (const [id, hits] of Object.entries(next[kind])) {
      previous[kind][id] = Math.max(previous[kind][id], hits);
    }
  }
  for (const [id, hits] of Object.entries(next.b)) {
    previous.b[id] = hits.map((value, index) =>
      Math.max(previous.b[id][index], value),
    );
  }
}

export function unionRuntimeCoverage(reports, inventory) {
  const merged = {};
  for (const raw of reports) {
    const parsed = reportSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Malformed native coverage report.");
    for (const [path, data] of Object.entries(parsed.data)) {
      const { key, file } = readCoverage(path, data, inventory);
      if (Object.hasOwn(merged, key)) mergeFile(merged[key], file);
      else merged[key] = file;
    }
  }
  return merged;
}

export function ownerRuntimeCoverage(report, files) {
  const owned = new Set(
    files.map((path) => resolve(path).replaceAll("\\", "/")),
  );
  return Object.fromEntries(
    Object.entries(report).filter(([path]) => owned.has(path)),
  );
}
