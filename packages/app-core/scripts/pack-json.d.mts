/** Lossless public metadata packing performed only during generation. */
export function packJsonRows(rows: readonly string[]): {
  rows: string[];
  dictionary: string[];
};
export function renderPackedJsonRows(
  name: string,
  rows: readonly string[],
): string;
