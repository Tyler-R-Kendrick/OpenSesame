import { describe, expect, it, vi } from "vitest";
import { parseRetiredCredentialRecords } from "./records.js";

const at = "2026-10-08T00:00:00.000Z";
const unavailable = "Retired credential records are unavailable.";
const trap = {
  id: "selected",
  createdAt: at,
  response: "reject",
  salt: "AAAAAAAAAAAAAAAAAAAAAA==",
  verifier: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const event = {
  type: "retired_credential_observed",
  trapId: "selected",
  at,
  response: "reject",
};
const fixture = { v: 1, tomb: "context", traps: [trap], events: [event] };
const raw = JSON.stringify(fixture);
const parse = (text: string) => parseRetiredCredentialRecords(text, "context");
const refused = (text: string) =>
  expect(() => parse(text)).toThrow(unavailable);

describe("retired record JSON refusal", () => {
  it.each([
    ['"v":1', '"v":0,"v":1'],
    ['"tomb":"context"', '"tomb":"foreign","tomb":"context"'],
    ['"traps":', '"traps":[],"traps":'],
    ['"events":', '"events":[],"events":'],
    ['"id":"selected"', '"id":"other","id":"selected"'],
    ['"createdAt":', '"createdAt":"bad","createdAt":'],
    ['"response":"reject"', '"response":"synthetic_decoy","response":"reject"'],
    ['"salt":', '"salt":"bad","salt":'],
    ['"verifier":', '"verifier":"bad","verifier":'],
    ['"type":', '"type":"unknown","type":'],
    ['"trapId":', '"trapId":"other","trapId":'],
    ['"at":', '"at":"bad","at":'],
  ])("refuses repeated known fields: %s", (needle, replacement) => {
    refused(raw.replace(needle, replacement));
  });

  it("refuses decoded aliases, identical repeats and nested action repeats", () => {
    refused(raw.replace('"v":1', '"v":1,"\\u0076":1'));
    refused(raw.replace('"id":', '"\\u0069d":"selected","id":'));
    refused(raw.replace('"trapId":', '"trap\\u0049d":"selected","trapId":'));
    const interaction = JSON.stringify({
      ...fixture,
      events: [
        {
          ...event,
          type: "synthetic_decoy_interaction",
          response: "synthetic_decoy",
          action: "vault_write",
        },
      ],
    });
    refused(
      interaction.replace('"action":', '"action":"authority_denied","action":'),
    );
  });

  it.each(["\ud800", "\udfff", "\ud800x", "x\udfff"])(
    "refuses invalid Unicode in bounded identifiers and context: %j",
    (text) => {
      refused(JSON.stringify({ ...fixture, traps: [{ ...trap, id: text }] }));
      refused(
        JSON.stringify({ ...fixture, events: [{ ...event, trapId: text }] }),
      );
      expect(() =>
        parseRetiredCredentialRecords(
          JSON.stringify({ ...fixture, tomb: text }),
          text,
        ),
      ).toThrow(unavailable);
      refused(raw.replace('"selected"', `"${text}"`));
      refused(raw.replace('"v"', `"${text}"`));
    },
  );

  it("preserves pairs, escaped aliases and structural characters inside strings", () => {
    const id = '🚀{}[]:,/"\\\\tail';
    const value = {
      ...fixture,
      traps: [{ ...trap, id }],
      events: [{ ...event, trapId: id }],
    };
    const encoded = JSON.stringify(value);
    expect(parse(encoded)).toEqual(value);
    expect(parse(encoded.replace('"id":', '"\\u0069d":'))).toEqual(value);
    expect(
      parse(encoded.replaceAll("🚀", "\\ud83d\\ude80").replaceAll("/", "\\/")),
    ).toEqual(value);
    expect(
      parse(
        JSON.stringify({
          ...fixture,
          traps: [trap, { ...trap, id: "second" }],
        }),
      ),
    ).toEqual({ ...fixture, traps: [trap, { ...trap, id: "second" }] });
  });

  it.each([
    `${raw} false`,
    `${raw},`,
    raw.slice(0, -1),
    raw.replace('"v":1', '"v":01'),
    raw.replace('"v":1', '"v":1e'),
    raw.replace('"id":"selected"', '"id":"bad\\q"'),
    raw.replace('"id":"selected"', '"id":"bad\\u123"'),
    raw.replace('"id":"selected"', '"id":"bad\\"'),
    raw.replace('"events":', '"events" '),
    raw.replace('"traps":[', '"traps":{'),
  ])("retains native grammar refusal: %s", refused);

  it("bounds code units and UTF-8 before parsing tokens or allocating encodings", () => {
    const parser = vi.spyOn(JSON, "parse");
    const encoder = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      refused(" ".repeat(32769));
      refused(`"${"é".repeat(16384)}"`);
      expect(parser).not.toHaveBeenCalled();
      expect(encoder).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
      encoder.mockRestore();
    }
  });

  it("refuses nested containers before recursive native parsing", () => {
    const parser = vi.spyOn(JSON, "parse");
    try {
      refused(`${"[".repeat(1000)}0${"]".repeat(1000)}`);
      expect(parser).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });
});
