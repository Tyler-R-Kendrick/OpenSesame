import { describe, expect, it } from "vitest";
import {
  PROTON_ITEM_MAX_BYTES,
  PROTON_ITEM_MAX_FIELDS,
  ProtonWireError,
  lastProtonMessage,
  readProtonFields,
  replaceLastProtonBytes,
} from "./proton-pass-wire.js";

const bytes = (...value: number[]) => new Uint8Array(value);
const utf8 = new TextDecoder("utf-8", { fatal: true });
// Synthetic data independently checked with genuine Proton WASM2.3.2.
const NOTE_HEX =
  "0a600a1f53796e74686574696320696e7465726f7065726162696c697479206e6f7465" +
  "121773796e746865746963206e6f746520636f6e74656e74731a2430303030303030" +
  "302d303030302d343030302d383030302d30303030303030303030303112021200";
const golden = Uint8Array.from(Buffer.from(NOTE_HEX, "hex"));
const unknown = bytes(
  0xa0,
  6,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  1,
  0xa9,
  6,
  0xf0,
  0xde,
  0xbc,
  0x9a,
  0x78,
  0x56,
  0x34,
  0x12,
  0xb2,
  6,
  3,
  65,
  66,
  67,
  0xbd,
  6,
  0x98,
  0xba,
  0xdc,
  0xfe,
);
const concatenate = (...parts: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts));

function message(fields: ReturnType<typeof readProtonFields>, fieldNo: number) {
  const value = lastProtonMessage(fields, fieldNo);
  if (value === null) throw new Error("Expected synthetic message");
  return value;
}

describe("Proton bounded wire messages", () => {
  it("reads a genuine-oracle synthetic Note without a shipped Proton runtime", () => {
    const item = readProtonFields(golden);
    const metadata = readProtonFields(message(item, 1));
    expect(utf8.decode(message(metadata, 1))).toBe(
      "Synthetic interoperability note",
    );
    expect(utf8.decode(message(metadata, 2))).toBe("synthetic note contents");
    expect(utf8.decode(message(metadata, 3))).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(message(readProtonFields(message(item, 2)), 2)).toEqual(bytes());
    expect(concatenate(...item.map((field) => field.raw))).toEqual(golden);
  });

  it("retains unknown varint/fixed64/bytes/fixed32 spans byte-for-byte", () => {
    const fields = readProtonFields(unknown);
    expect(fields.map((field) => [field.fieldNo, field.wireType])).toEqual([
      [100, 0],
      [101, 1],
      [102, 2],
      [103, 5],
    ]);
    expect(concatenate(...fields.map((field) => field.raw))).toEqual(unknown);
    expect(fields[2]?.message).toEqual(bytes(65, 66, 67));
  });

  it("keeps a non-minimal valid unknown encoding unchanged", () => {
    const encoded = bytes(0xa0, 6, 0x81, 0);
    expect(readProtonFields(encoded)[0]?.raw).toEqual(encoded);
  });

  it("selects the last whole Metadata message without reviving prior fields", () => {
    // First Metadata has note A; the last has only title B. Official sees no note.
    const original = bytes(10, 3, 18, 1, 65, 10, 3, 10, 1, 66);
    const visible = readProtonFields(message(readProtonFields(original), 1));
    expect(lastProtonMessage(visible, 2)).toBeNull();
    expect(utf8.decode(message(visible, 1))).toBe("B");
    const edited = replaceLastProtonBytes(original, 1, bytes(10, 1, 67));
    expect(edited).toEqual(bytes(10, 3, 18, 1, 65, 10, 3, 10, 1, 67));
    expect(readProtonFields(edited)[0]?.raw).toEqual(
      readProtonFields(original)[0]?.raw,
    );
  });

  it("updates only the final same-oneof Login and preserves earlier wire bytes", () => {
    // Earlier Login email A; visible final Login username B.
    const content = bytes(26, 3, 10, 1, 65, 26, 3, 50, 1, 66);
    const visible = readProtonFields(message(readProtonFields(content), 3));
    expect(lastProtonMessage(visible, 1)).toBeNull();
    expect(message(visible, 6)).toEqual(bytes(66));
    expect(replaceLastProtonBytes(content, 3, bytes(50, 1, 67))).toEqual(
      bytes(26, 3, 10, 1, 65, 26, 3, 50, 1, 67),
    );
  });

  it("preserves nested and top-level unknowns when composing an actual Note edit", () => {
    const item = readProtonFields(golden);
    const metadata = concatenate(message(item, 1), unknown);
    const before = concatenate(
      replaceLastProtonBytes(golden, 1, metadata),
      unknown,
    );
    const changed = replaceLastProtonBytes(metadata, 2, bytes(67));
    const after = replaceLastProtonBytes(before, 1, changed);
    expect(after.subarray(-unknown.length)).toEqual(unknown);
    const afterMetadata = message(readProtonFields(after), 1);
    expect(afterMetadata.subarray(-unknown.length)).toEqual(unknown);
    expect(message(readProtonFields(afterMetadata), 2)).toEqual(bytes(67));
    expect(message(readProtonFields(after), 2)).toEqual(message(item, 2));
  });

  it("appends a missing message and accepts an explicitly empty message", () => {
    expect(replaceLastProtonBytes(bytes(16, 1), 1, bytes())).toEqual(
      bytes(16, 1, 10, 0),
    );
    expect(lastProtonMessage(readProtonFields(bytes(10, 0)), 1)).toEqual(
      bytes(),
    );
  });

  const malformed = [
    [0],
    [14],
    [15],
    [128],
    [10, 128],
    [10, 2, 65],
    [9, 1, 2, 3, 4, 5, 6, 7],
    [13, 1, 2, 3],
    [8, 128],
    [8, ...Array(10).fill(128)],
    [8, ...Array(9).fill(255), 2],
    [10, 128, 128, 128, 128, 16],
    [10, 128, 128, 128, 128, 128, 0],
    [128, 128, 128, 128, 16],
    [128, 128, 128, 128, 128, 0],
  ];
  it.each(malformed)(
    "rejects malformed input %# without raw payload errors",
    (...input) => {
      let thrown: unknown;
      try {
        readProtonFields(bytes(...input));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProtonWireError);
      expect(thrown).toMatchObject({ code: "format" });
      expect(String(thrown)).not.toContain(Buffer.from(input).toString("hex"));
    },
  );

  it.each([[11], [12], [11, 12]])(
    "rejects unsupported group input %#",
    (...input) => {
      expect(() => readProtonFields(bytes(...input))).toThrowError(
        expect.objectContaining({ code: "unsupported" }),
      );
    },
  );

  it("bounds bytes before parsing and fields across known nested messages", () => {
    expect(() =>
      readProtonFields(new Uint8Array(PROTON_ITEM_MAX_BYTES + 1)),
    ).toThrowError(expect.objectContaining({ code: "limit" }));
    const pairs = new Uint8Array(PROTON_ITEM_MAX_FIELDS * 2);
    for (let index = 0; index < pairs.length; index += 2) pairs[index] = 8;
    expect(readProtonFields(pairs)).toHaveLength(PROTON_ITEM_MAX_FIELDS);
    expect(() =>
      readProtonFields(concatenate(pairs, bytes(8, 0))),
    ).toThrowError(expect.objectContaining({ code: "limit" }));
    const budget = { remaining: 1 };
    readProtonFields(bytes(10, 2, 8, 0), budget);
    expect(() => readProtonFields(bytes(8, 0), budget)).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
  });

  it.each([-1, 0, 1.5, 0x2000_0000, Number.NaN])(
    "refuses unsafe replacement field %s",
    (field) => {
      expect(() =>
        replaceLastProtonBytes(bytes(), field, bytes()),
      ).toThrowError(expect.objectContaining({ code: "format" }));
    },
  );

  it("enforces the field bound on append while allowing a full-item replacement", () => {
    const pairs = new Uint8Array(PROTON_ITEM_MAX_FIELDS * 2);
    for (let index = 0; index < pairs.length; index += 2) pairs[index] = 16;
    const partial = pairs.subarray(0, pairs.length - 2);
    const appended = replaceLastProtonBytes(partial, 1, bytes());
    expect(readProtonFields(appended)).toHaveLength(PROTON_ITEM_MAX_FIELDS);
    expect(() => replaceLastProtonBytes(pairs, 1, bytes())).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
    const replaced = replaceLastProtonBytes(appended, 1, bytes(8, 1));
    expect(readProtonFields(replaced)).toHaveLength(PROTON_ITEM_MAX_FIELDS);
    expect(lastProtonMessage(readProtonFields(replaced), 1)).toEqual(
      bytes(8, 1),
    );
  });

  it("refuses reinterpreting a scalar but keeps a new bytes value opaque", () => {
    expect(() => replaceLastProtonBytes(bytes(8, 1), 1, bytes())).toThrowError(
      expect.objectContaining({ code: "format" }),
    );
    expect(replaceLastProtonBytes(bytes(), 1, bytes(0))).toEqual(
      bytes(10, 1, 0),
    );
  });

  it("bounds the composed output without changing either caller-owned input", () => {
    // Largest permitted original: unknown bytes field fills the byte bound.
    const original = new Uint8Array(PROTON_ITEM_MAX_BYTES);
    original.set([18, 252, 255, 63]);
    const before = original.slice();
    const payload = bytes(8, 1);
    expect(() => replaceLastProtonBytes(original, 1, payload)).toThrowError(
      expect.objectContaining({ code: "limit" }),
    );
    expect(original).toEqual(before);
    expect(payload).toEqual(bytes(8, 1));
  });
});
