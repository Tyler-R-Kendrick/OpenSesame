import { type JsonValue, recordSchema } from "./provider-schema.js";
import { type RecordValue, record, records } from "./transport.js";
/** Provider receipts may add metadata, but every supplied property must survive. */
export function preserves(
  expected: JsonValue | undefined,
  actual: JsonValue | undefined,
): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => preserves(value, actual[index]))
    );
  const expectedRecord = recordSchema.safeParse(expected);
  if (expectedRecord.success) {
    const actualRecord = recordSchema.safeParse(actual);
    if (!actualRecord.success) return false;
    return Object.entries(expectedRecord.data).every(([key, value]) =>
      preserves(value, actualRecord.data[key]),
    );
  }
  return expected === actual;
}
export function templatePreserved(
  expected: RecordValue,
  actual: RecordValue,
): boolean {
  const expectedFields = records(expected.fields);
  const remaining = [...records(actual.fields)];
  if (expectedFields.length !== remaining.length) return false;
  for (const field of expectedFields) {
    const match = remaining.findIndex((candidate) =>
      preserves(field, candidate),
    );
    if (match < 0) return false;
    remaining.splice(match, 1);
  }
  if (!preserves(record(expected.vault).name, record(actual.vault).name))
    return false;
  for (const key of ["sections", "urls", "tags", "notesPlain"])
    if (!preserves(expected[key], actual[key])) return false;
  return true;
}
