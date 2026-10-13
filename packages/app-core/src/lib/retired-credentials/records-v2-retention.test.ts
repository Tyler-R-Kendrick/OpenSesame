import { expect, it } from "vitest";
import profile from "../../../../../spec/conformance/retired-retention-v2.json";
import fixtures from "./fixtures/records-v2-pages-vectors.json";
import {
  encodeRetiredCredentialRecordsV2,
  parseRetiredCredentialRecordsV2,
} from "./records-v2.js";
const v = required(fixtures.vectors[0]);
it("requires explicit expiry, keeps expired records and preserves observations", () => {
  const original = parseRetiredCredentialRecordsV2(
    v.recordJson,
    v.expectedContextWire,
  );
  const before = JSON.stringify(original);
  const parsed = parseRetiredCredentialRecordsV2(before, v.expectedContextWire);
  expect(required(parsed.traps[0]).expiresAt).toBe("2027-01-06T00:00:00.000Z");
  expect(parsed.events).toEqual(original.events);
  expect(
    JSON.parse(encodeRetiredCredentialRecordsV2(before, v.expectedContextWire)),
  ).toEqual(original);
  const withoutExpiry = {
    ...original,
    traps: original.traps.map((trap) => ({ ...trap, expiresAt: undefined })),
  };
  expect(() =>
    parseRetiredCredentialRecordsV2(
      JSON.stringify(withoutExpiry),
      v.expectedContextWire,
    ),
  ).toThrow();
  expect(before).toBe(v.recordJson);
});
it.each(profile.invalid)(
  "rejects shared invalid interval $createdAt $expiresAt without repairing",
  (entry) => {
    const record = parseRetiredCredentialRecordsV2(
      v.recordJson,
      v.expectedContextWire,
    );
    Object.assign(required(record.traps[0]), entry);
    const raw = JSON.stringify(record);
    expect(() =>
      parseRetiredCredentialRecordsV2(raw, v.expectedContextWire),
    ).toThrow();
    expect(JSON.stringify(record)).toBe(raw);
  },
);
it("expiry decoded aliases remain ambiguous and V1 cannot receive an implicit expiry", () => {
  const raw = v.recordJson.replace(
    '"expiresAt":',
    '"expiresAt":"2027-01-06T00:00:00.000Z","expires\\u0041t":',
  );
  expect(() =>
    parseRetiredCredentialRecordsV2(raw, v.expectedContextWire),
  ).toThrow();
  expect(() =>
    parseRetiredCredentialRecordsV2(
      '{"v":1,"tomb":"personal","traps":[],"events":[]}',
      v.expectedContextWire,
    ),
  ).toThrow();
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing genuine fixture value.");
  return value;
}
