import { describe, expect, it, vi } from "vitest";
import {
  MAX_RETIRED_CREDENTIAL_RECORD_BYTES,
  parseRetiredCredentialRecords,
} from "./records.js";

const tomb = "tomb-é";
const at = "2026-10-08T00:00:00.000Z";
const unavailable = "Retired credential records are unavailable.";
const trap = (id = "trap-1") => ({
  id,
  createdAt: at,
  response: "reject",
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
  verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
});
const observed = () => ({
  type: "retired_credential_observed",
  trapId: "trap-1",
  at,
  response: "reject",
});
const records = () => ({ v: 1, tomb, traps: [trap()], events: [observed()] });
const parse = <T>(value: T) =>
  parseRetiredCredentialRecords(JSON.stringify(value), tomb);

function refused<T>(value: T): void {
  expect(() => parse(value)).toThrow(unavailable);
}

describe("retired credential record boundary", () => {
  it("reads an empty record and retains the selected metadata exactly", () => {
    expect(parse({ v: 1, tomb, traps: [], events: [] })).toEqual({
      v: 1,
      tomb,
      traps: [],
      events: [],
    });
    expect(parse(records())).toEqual(records());
  });

  it("accepts only the bounded maximum, including both non-destructive responses", () => {
    const value = records();
    value.traps = [trap("one"), trap("two"), trap("three")];
    value.traps[1].response = "synthetic_decoy";
    value.events = Array.from({ length: 32 }, observed);
    expect(parse(value)).toEqual(value);
    refused({ ...value, traps: [...value.traps, trap("four")] });
    refused({ ...value, events: [...value.events, observed()] });
    refused({ ...value, traps: [trap("one"), trap("one")] });
  });

  it.each(["visible_items", "freeze", "wipe", "attacker_confirmed"])(
    "refuses an unsupported response: %s",
    (response) => {
      refused({ ...records(), traps: [{ ...trap(), response }] });
      refused({ ...records(), events: [{ ...observed(), response }] });
    },
  );

  it("admits only the selected synthetic interaction actions", () => {
    for (const action of ["vault_write", "authority_denied"]) {
      const event = {
        type: "synthetic_decoy_interaction",
        trapId: "trap-1",
        at,
        response: "synthetic_decoy",
        action,
      };
      const value = { ...records(), events: [event] };
      expect(parse(value).events).toEqual([event]);
      refused({ ...value, events: [{ ...event, response: "reject" }] });
      refused({ ...value, events: [{ ...event, action: "wipe" }] });
    }
    refused({
      ...records(),
      events: [{ ...observed(), type: "attacker_confirmed" }],
    });
  });

  it("rejects context substitution without case folding or Unicode normalization", () => {
    for (const context of ["other", "TOMB-é", "tomb-e\u0301", ""]) {
      expect(() =>
        parseRetiredCredentialRecords(JSON.stringify(records()), context),
      ).toThrow(unavailable);
    }
  });

  it("rejects unexpected fields at every level", () => {
    refused({ ...records(), productionAuthority: true });
    refused({
      ...records(),
      traps: [{ ...trap(), password: "synthetic-fixture" }],
    });
    refused({ ...records(), events: [{ ...observed(), authority: "real" }] });
    refused({
      ...records(),
      events: [
        {
          type: "synthetic_decoy_interaction",
          trapId: "trap-1",
          at,
          response: "synthetic_decoy",
          action: "vault_write",
          productionAuthority: true,
        },
      ],
    });
  });

  it("rejects unsupported versions and malformed, empty or overlong identifiers", () => {
    refused({ ...records(), v: 2 });
    refused({ ...records(), tomb: "x".repeat(257) });
    for (const id of ["", "x".repeat(129)]) {
      refused({ ...records(), traps: [trap(id)] });
      refused({ ...records(), events: [{ ...observed(), trapId: id }] });
    }
    refused({ ...records(), traps: [{ ...trap(), createdAt: "not-a-date" }] });
    refused({ ...records(), events: [{ ...observed(), at: "not-a-date" }] });
  });

  it("bounds identifiers by UTF-8 bytes, including multibyte input", () => {
    expect(
      parse({ ...records(), traps: [trap("é".repeat(64))] }).traps[0].id,
    ).toBe("é".repeat(64));
    refused({ ...records(), traps: [trap("é".repeat(65))] });
    refused({
      ...records(),
      events: [{ ...observed(), trapId: "é".repeat(65) }],
    });
    const context = "é".repeat(128);
    expect(
      parseRetiredCredentialRecords(
        JSON.stringify({ v: 1, tomb: context, traps: [], events: [] }),
        context,
      ).tomb,
    ).toBe(context);
    const tooLong = `${context}é`;
    expect(() =>
      parseRetiredCredentialRecords(
        JSON.stringify({ v: 1, tomb: tooLong, traps: [], events: [] }),
        tooLong,
      ),
    ).toThrow(unavailable);
    const longDate = `2026-10-08T00:00:00.${"0".repeat(45)}Z`;
    refused({ ...records(), traps: [{ ...trap(), createdAt: longDate }] });
    refused({ ...records(), events: [{ ...observed(), at: longDate }] });
  });

  it("accepts timestamps exactly at the length bound and refuses one more digit", () => {
    const exact = `2026-10-08T00:00:00.${"0".repeat(43)}Z`;
    const over = `2026-10-08T00:00:00.${"0".repeat(44)}Z`;
    expect(exact.length).toBe(64);
    expect(over.length).toBe(65);
    const value = {
      ...records(),
      traps: [{ ...trap(), createdAt: exact }],
      events: [{ ...observed(), at: exact }],
    };
    expect(parse(value)).toEqual(value);
    refused({ ...value, traps: [{ ...trap(), createdAt: over }] });
    refused({ ...value, events: [{ ...observed(), at: over }] });
  });

  it("counts astral identifiers by UTF-8 bytes rather than UTF-16 units", () => {
    const exact = "🚀".repeat(32);
    const over = `${exact}🚀`;
    expect(new TextEncoder().encode(exact).length).toBe(128);
    const value = {
      ...records(),
      traps: [trap(exact)],
      events: [{ ...observed(), trapId: exact }],
    };
    expect(parse(value)).toEqual(value);
    refused({ ...value, traps: [trap(over)] });
    refused({ ...value, events: [{ ...observed(), trapId: over }] });
  });

  it("admits nonzero standard Base64 containing both plus and slash", () => {
    const value = {
      ...records(),
      traps: [
        {
          ...trap(),
          salt: "+/v7+/v7+/v7+/v7+/v7+w==",
          verifier: "//////////////////////////////////////////8=",
        },
      ],
    };
    expect(parse(value)).toEqual(value);
  });

  it("requires canonical padded salt and verifier encodings", () => {
    for (const salt of [
      "",
      "AAAAAAAAAAAAAAAAAAAAAB==",
      "AAAAAAAAAAAAAAAAAAAAAA",
      `${"!".repeat(22)}==`,
    ]) {
      refused({ ...records(), traps: [{ ...trap(), salt }] });
    }
    for (const verifier of [
      "",
      `${"A".repeat(42)}B=`,
      "A".repeat(43),
      `${"!".repeat(43)}=`,
    ]) {
      refused({ ...records(), traps: [{ ...trap(), verifier }] });
    }
    for (const last of ["A", "Q", "g", "w"]) {
      const value = {
        ...records(),
        traps: [{ ...trap(), salt: `${"A".repeat(21) + last}==` }],
      };
      expect(parse(value)).toEqual(value);
    }
    for (const last of "AEIMQUYcgkosw048") {
      const value = {
        ...records(),
        traps: [{ ...trap(), verifier: `${"A".repeat(42) + last}=` }],
      };
      expect(parse(value)).toEqual(value);
    }
  });

  it.each(["", "{", "null", "[]", "true", '"synthetic-fixture"'])(
    "refuses malformed or non-record JSON with a generic error: %s",
    (raw) =>
      expect(() => parseRetiredCredentialRecords(raw, tomb)).toThrow(
        unavailable,
      ),
  );

  it("bounds UTF-8 bytes exactly, including bounded multibyte context text", () => {
    const raw = JSON.stringify({ v: 1, tomb, traps: [], events: [] });
    const bytes = new TextEncoder().encode(raw).length;
    const atLimit =
      raw + " ".repeat(MAX_RETIRED_CREDENTIAL_RECORD_BYTES - bytes);
    expect(atLimit.length).toBeLessThan(MAX_RETIRED_CREDENTIAL_RECORD_BYTES);
    expect(new TextEncoder().encode(atLimit).length).toBe(
      MAX_RETIRED_CREDENTIAL_RECORD_BYTES,
    );
    expect(parseRetiredCredentialRecords(atLimit, tomb)).toEqual({
      v: 1,
      tomb,
      traps: [],
      events: [],
    });
    expect(() => parseRetiredCredentialRecords(`${atLimit} `, tomb)).toThrow(
      unavailable,
    );
  });

  it("refuses grossly oversized input before allocating a UTF-8 buffer", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      expect(() =>
        parseRetiredCredentialRecords(
          " ".repeat(MAX_RETIRED_CREDENTIAL_RECORD_BYTES + 1),
          tomb,
        ),
      ).toThrow(unavailable);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });
});
