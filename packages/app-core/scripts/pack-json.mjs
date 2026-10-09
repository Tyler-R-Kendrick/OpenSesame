/** Lossless build-time packing; generated plans and policy keep their exact JSON. */
function candidates(rows) {
  const counts = new Map();
  const note = (fragment) => {
    if (fragment.length > 8 && fragment.length < 200)
      counts.set(fragment, (counts.get(fragment) ?? 0) + 1);
  };
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      for (const [key, item] of Object.entries(value)) {
        const prefix = `${JSON.stringify(key)}:`;
        note(prefix);
        note(`${prefix}${JSON.stringify(item)}`);
        visit(item);
      }
    } else note(JSON.stringify(value));
  };
  for (const row of rows) visit(JSON.parse(row));
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([a, ca], [b, cb]) => {
      const score = (fragment, count) =>
        (fragment.length - 6) * count - fragment.length;
      const difference = score(b, cb) - score(a, ca);
      return difference || (a < b ? -1 : a > b ? 1 : 0);
    });
}
export function packJsonRows(rows) {
  if (rows.some((row) => /~[0-9a-f]+~/.test(row)))
    throw new Error(
      "Public JSON contains a reserved generated fragment marker",
    );
  let packed = [...rows];
  const dictionary = [];
  for (const [fragment] of candidates(rows)) {
    const marker = `~${dictionary.length.toString(16)}~`;
    const occurrences = packed.reduce(
      (count, row) => count + row.split(fragment).length - 1,
      0,
    );
    const saved = (fragment.length - marker.length) * occurrences;
    if (saved <= JSON.stringify(fragment).length + 3) continue;
    packed = packed.map((row) => row.split(fragment).join(marker));
    dictionary.push(fragment);
  }
  return { rows: packed, dictionary };
}
export function renderPackedJsonRows(name, rows) {
  const packed = packJsonRows(rows);
  return [
    'import { unpackGeneratedJson } from "./generated-json.js";',
    `const dictionary = ${JSON.stringify(packed.dictionary.join("\n"))}.split("\\n");`,
    `const rows: readonly string[] = ${JSON.stringify(packed.rows)};`,
    `export const ${name}: readonly string[] = rows.map((row) => unpackGeneratedJson(row, dictionary));`,
  ].join("\n");
}
