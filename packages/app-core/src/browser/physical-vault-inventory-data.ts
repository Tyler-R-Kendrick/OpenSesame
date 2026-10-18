/** Bounded physical namespace completeness DATA; registry rows alone cannot prove absence. */
import { kvFileName } from "../lib/kv.js";
import { ORIGIN_FILE_PREFIX } from "../lib/storage-ownership.js";
import { readBrowserPhysicalRegistryData } from "./physical-vault-name-data.js";

type Source = Readonly<{
  read: (key: string, bound: number) => Promise<string | null>;
  listPhysicalNames: () => Promise<readonly string[]>;
  check: () => void;
}>;
const paths = ["header", "body", "retired-credentials.v2"] as const;
const relevantSuffix =
  /^tomb_.*_(?:header|body|retired-credentials\.v2)\.json$/u;
function relevantName(name: string) {
  return (
    name.startsWith(ORIGIN_FILE_PREFIX) &&
    relevantSuffix.test(name.slice(ORIGIN_FILE_PREFIX.length))
  );
}
function unavailable(): never {
  throw new Error("Original browser vault inventory is unavailable.");
}
export async function captureBrowserPhysicalInventoryData(source: Source) {
  const wire = await source.read("tombs.v1", 32768);
  const tombs = readBrowserPhysicalRegistryData(wire);
  const expected = new Set(
    tombs.flatMap((tomb) =>
      paths.map((path) => kvFileName(`tomb/${tomb}/${path}`)),
    ),
  );
  const names = (await source.listPhysicalNames()).filter((name) =>
    relevantName(name),
  );
  for (const name of names) if (!expected.has(name)) unavailable();
  if ((await source.read("tombs.v1", 32768)) !== wire) unavailable();
  const nextNames = (await source.listPhysicalNames()).filter(relevantName);
  if (JSON.stringify(nextNames) !== JSON.stringify(names)) unavailable();
  source.check();
  return Object.freeze({ wire, tombs, names: Object.freeze(names) });
}
export async function revalidateBrowserPhysicalInventoryData(
  source: Source,
  expected: Awaited<ReturnType<typeof captureBrowserPhysicalInventoryData>>,
) {
  const current = await captureBrowserPhysicalInventoryData(source);
  if (
    current.wire !== expected.wire ||
    JSON.stringify(current.names) !== JSON.stringify(expected.names)
  )
    unavailable();
}
