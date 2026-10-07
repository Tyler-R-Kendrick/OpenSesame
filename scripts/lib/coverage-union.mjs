import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const startPosition = z
  .object({
    line: z.number().int().positive().safe(),
    column: z.number().int().nonnegative().safe(),
  })
  .passthrough();
const endPosition = startPosition.extend({
  column: z.number().int().nonnegative().safe().nullable(),
});
const location = z
  .object({ start: startPosition, end: endPosition })
  .passthrough();
const implicitBranch = z
  .object({ start: z.object({}).strict(), end: z.object({}).strict() })
  .strict();
const unsigned = z.number().int().nonnegative().safe();
const signed = z.number().int().safe();
const ids = z.string().regex(/^\d+$/u);
const schema = z
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
          type: z.enum([
            "if",
            "binary-expr",
            "cond-expr",
            "default-arg",
            "switch",
          ]),
          loc: location,
          locations: z.array(z.union([location, implicitBranch])),
        })
        .passthrough(),
    ),
    s: z.record(ids, unsigned),
    f: z.record(ids, unsigned),
    b: z.record(ids, z.array(signed)),
  })
  .passthrough();
const kinds = [
  ["s", "statementMap"],
  ["f", "fnMap"],
  ["b", "branchMap"],
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
const signature = (value) => JSON.stringify(stable(value));
function sameKeys(a, b) {
  return isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort());
}
function validateMaps(file) {
  for (const [counter, map] of kinds)
    if (!sameKeys(file[counter], file[map]))
      throw Error("Native map/counter keys differ");
  for (const [id, hits] of Object.entries(file.b)) {
    const branch = file.branchMap[id];
    if (hits.length !== branch.locations.length)
      throw Error("Native branch dimensions differ");
    for (let arm = 0; arm < hits.length; arm++)
      if (hits[arm] < 0) {
        if (
          branch.type !== "if" ||
          hits.length !== 2 ||
          arm !== 1 ||
          !implicitBranch.safeParse(branch.locations[arm]).success
        )
          throw Error("Negative explicit native branch counter");
      }
  }
}
function readNative(path, raw, inventory) {
  if (!validJson(raw)) throw Error("Invalid non-JSON native metadata");
  if (!isAbsolute(path)) throw Error("Coverage identity must be absolute");
  const key = resolve(path).replaceAll("\\", "/");
  const expected = inventory.get(key);
  const parsed = schema.safeParse(raw);
  if (expected === undefined || !parsed.success)
    throw Error("Invalid or foreign native runtime coverage");
  const file = structuredClone(raw);
  if (
    !isAbsolute(file.path) ||
    resolve(file.path).replaceAll("\\", "/") !== key ||
    file.sourceSha256 !== expected
  )
    throw Error("Native source identity differs");
  validateMaps(file);
  return { key, file };
}
function groupsOf(map) {
  const groups = new Map();
  for (const [id, value] of Object.entries(map)) {
    const metadata = signature(value);
    const group = groups.get(metadata) ?? { value, ids: [] };
    group.ids.push(id);
    groups.set(metadata, group);
  }
  for (const group of groups.values())
    group.ids.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return groups;
}
function maxima(previous, next) {
  if (Array.isArray(next))
    return next.map((hit, arm) => Math.max(previous[arm], hit));
  return Math.max(previous, next);
}
function emptyFile(file) {
  return {
    path: file.path,
    sourceSha256: file.sourceSha256,
    kinds: Object.fromEntries(kinds.map(([counter]) => [counter, new Map()])),
    duplicateIds: Object.fromEntries(
      kinds.map(([counter]) => [counter, new Map()]),
    ),
    origins: [],
  };
}
function duplicateIdentity(file, counter, metadata, ids, mapSha256) {
  const previous = file.duplicateIds[counter].get(metadata);
  if (
    previous &&
    (previous.ids.length > 1 || ids.length > 1) &&
    (!isDeepStrictEqual(previous.ids, ids) || previous.mapSha256 !== mapSha256)
  )
    throw Error(
      "Ambiguous native duplicate occurrences: retain failure instead of guessing their bijection",
    );
  file.duplicateIds[counter].set(metadata, { ids: [...ids], mapSha256 });
}
function appendKind(target, next, counter, map) {
  const mapping = {};
  const mapSha256 = sha(signature(next[map]));
  for (const [metadata, group] of groupsOf(next[map])) {
    duplicateIdentity(target, counter, metadata, group.ids, mapSha256);
    for (let occurrence = 0; occurrence < group.ids.length; occurrence++) {
      const nativeId = group.ids[occurrence];
      const nativeCounter = next[counter][nativeId];
      const material = `${counter}\n${metadata}\n${occurrence}`;
      const siteHash = sha(material);
      const previous = target.kinds[counter].get(siteHash);
      if (previous && previous.material !== material)
        throw Error("Source-site hash collision");
      const value = previous
        ? maxima(previous.counter, nativeCounter)
        : structuredClone(nativeCounter);
      target.kinds[counter].set(siteHash, {
        material,
        metadata: structuredClone(group.value),
        occurrence,
        counter: value,
      });
      mapping[nativeId] = {
        siteHash,
        occurrence,
        nativeCounter: structuredClone(nativeCounter),
      };
    }
  }
  return mapping;
}
function finalizeFile(path, file) {
  const data = { path, sourceSha256: file.sourceSha256 };
  const sites = {};
  for (const [counter, map] of kinds) {
    data[counter] = {};
    data[map] = {};
    sites[counter] = {};
    const entries = [...file.kinds[counter]].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (let id = 0; id < entries.length; id++) {
      const [siteHash, site] = entries[id];
      data[map][id] = structuredClone(site.metadata);
      data[counter][id] = structuredClone(site.counter);
      sites[counter][id] = { siteHash, occurrence: site.occurrence };
    }
  }
  return {
    data,
    provenance: {
      sourceSha256: file.sourceSha256,
      sites,
      origins: file.origins,
    },
  };
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validContainerDescriptors(value, descriptors) {
  if (Array.isArray(value)) {
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== value.length) return false;
    for (let i = 0; i < value.length; i++)
      if (!Object.hasOwn(descriptors, String(i))) return false;
    return true;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}
function validJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0);
  if (
    !value ||
    typeof value !== "object" ||
    ancestors.has(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!validContainerDescriptors(value, descriptors)) return false;
  ancestors.add(value);
  const valid = Object.entries(descriptors).every(([key, descriptor]) => {
    if (Array.isArray(value) && key === "length") return true;
    return (
      Object.hasOwn(descriptor, "value") &&
      descriptor.enumerable &&
      validJson(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}
function copyContext(context) {
  if (!validJson(context)) throw Error("Invalid provenance context");
  const copy = structuredClone(context);
  if (
    !copy ||
    Array.isArray(copy) ||
    Object.getPrototypeOf(copy) !== Object.prototype ||
    !validJson(copy)
  )
    throw Error("Invalid provenance context");
  return freeze(copy);
}
export function createExactSiteUnion(inventory) {
  const sourceInventory = new Map(inventory);
  const files = new Map();
  let reportIndex = 0;
  let failed = false;
  let sealed = false;
  return {
    append(raw, context = {}) {
      if (failed || sealed) throw Error("Coverage accumulator is closed");
      try {
        if (!validJson(raw) || !z.record(z.unknown()).safeParse(raw).success)
          throw Error("Malformed native coverage report");
        const retainedContext = copyContext(context);
        const report = reportIndex++;
        for (const [path, entry] of Object.entries(raw)) {
          const { key, file } = readNative(path, entry, sourceInventory);
          const target = files.get(key) ?? emptyFile(file);
          if (target.sourceSha256 !== file.sourceSha256)
            throw Error("Native target source identity differs");
          const standard = new Set(["path", "sourceSha256", ...kinds.flat()]);
          const nativeExtras = structuredClone(
            Object.fromEntries(
              Object.entries(file).filter(([key]) => !standard.has(key)),
            ),
          );
          const origin = {
            report,
            context: retainedContext,
            recordKey: path,
            nativePath: file.path,
            nativeExtras,
            maps: {},
            mapSha256: {},
          };
          for (const [counter, map] of kinds) {
            origin.maps[counter] = appendKind(target, file, counter, map);
            origin.mapSha256[map] = sha(signature(file[map]));
          }
          target.origins.push(origin);
          files.set(key, target);
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    finish() {
      if (failed || sealed) throw Error("Coverage accumulator is closed");
      sealed = true;
      const coverage = {};
      const provenance = {};
      for (const [path, file] of [...files].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const result = finalizeFile(path, file);
        coverage[path] = result.data;
        provenance[path] = result.provenance;
      }
      return freeze(structuredClone({ coverage, provenance }));
    },
  };
}
export function unionRuntimeCoverage(reports, inventory) {
  const union = createExactSiteUnion(inventory);
  for (const report of reports) union.append(report);
  return union.finish().coverage;
}
export function ownerRuntimeCoverage(report, files) {
  const owned = new Set(
    files.map((path) => resolve(path).replaceAll("\\", "/")),
  );
  return Object.fromEntries(
    Object.entries(report).filter(([path]) => owned.has(path)),
  );
}
