/**
 * The inputs of `spec/conformance/request-digest-vectors.json` (ADR 0139,
 * ADR 0156).
 *
 * Only the *requests* are written here. The canonical details string and the
 * digest of every case are produced by `canonicalRequestDigest` itself when
 * the file is regenerated — never typed in — so the vectors are what this
 * implementation computes, and the Rust reader (`crates/agent-hooks`
 * `interaction::digest`) has to arrive at the same bytes independently.
 *
 * The cases are chosen to break a second implementation, not to pass one:
 * every place two encoders plausibly disagree has its own case.
 */

import type { CanonicalRequest } from "../crypto/request-digest.js";

export interface DigestCase {
  readonly name: string;
  /** What the case is here to break. */
  readonly note: string;
  readonly request: CanonicalRequest;
  /** Another case whose digest this one must equal. Otherwise all differ. */
  readonly equivalentTo?: string;
  /**
   * The details as JSON *text*, when the case is about how text is read:
   * `JSON.stringify` cannot write an integer past 2^53 back out as it was
   * given, so the file carries the literal and each reader parses it itself.
   */
  readonly detailsJson?: string;
}

const BASE = {
  kind: "authorization_request",
  subject: "authorization_request:areq_7sQ2mVn1",
  approverRef: "inbox_YXBwcm92ZXI.tagtagtagtagtagtagtagtagtagtagta",
  requesterRef: "req_abcdefghijklmnopqrstuvwx",
  bindingMessage: "Approve an agent action: pre_tool_call",
  expiresAt: "2026-09-28T12:05:00.000Z",
} as const;

function request(
  authorizationDetails: CanonicalRequest["authorizationDetails"],
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return { ...BASE, authorizationDetails, ...overrides };
}

export const DIGEST_CASES: readonly DigestCase[] = [
  {
    name: "minimal_detail",
    note: "one detail carrying only its type",
    request: request([{ type: "connection_delegation" }]),
  },
  {
    name: "approver_detail",
    note: "the detail the Interaction approver sends, context_identity inside",
    request: request([
      {
        type: "agent_hooks_approval",
        actions: ["pre_tool_call"],
        locations: ["deploy"],
        spec: "agent-hooks/0.1",
        context_identity:
          "sha256:0f3a5f0e8c1d4b6a9e2f7c1b3d5a8e0f2c4b6d8a0e1f3c5b7d9a1e3f5c7b9d1a",
        interception_point: "pre_tool_call",
        reason: "acme:change_window",
        agent: "agent-7",
      },
    ]),
  },
  {
    name: "keys_sorted",
    note: "keys already in order, nested objects included",
    request: request([
      { a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] }, type: "t" },
    ]),
  },
  {
    name: "keys_reversed",
    note: "the same detail with every object's keys in reverse order: sorting is recursive",
    request: request([
      { type: "t", b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 },
    ]),
    equivalentTo: "keys_sorted",
  },
  {
    name: "array_order_forward",
    note: "array order is meaning: locations in one order",
    request: request([{ type: "t", locations: ["repo:a", "repo:b"] }]),
  },
  {
    name: "array_order_backward",
    note: "the same locations reversed must not collide with the forward order",
    request: request([{ type: "t", locations: ["repo:b", "repo:a"] }]),
  },
  {
    name: "details_order",
    note: "the details list is ordered too",
    request: request([{ type: "second" }, { type: "first" }]),
  },
  {
    name: "utf16_key_order",
    note: "U+FF5E sorts after an astral key in UTF-16 code units but before it in UTF-8 bytes; canonical order is UTF-16",
    request: request([{ type: "t", "～": 1, "\u{1F600}": 2, z: 3, "": 4 }]),
  },
  {
    name: "integer_like_keys",
    note: "an object's canonical-array-index keys (0..4294967294, no leading zero) come first in ascending numeric order, then every other key in UTF-16 order: that is how JSON.stringify walks the sorted object",
    detailsJson:
      '[{"type":"t","10":1,"9":2,"b":3,"01":4,"4294967294":5,"4294967295":6,"-1":7,"1.5":8,"0":9,"a":0,"9007199254740993":1,"4294967296":2}]',
    request: request(
      JSON.parse(
        '[{"type":"t","10":1,"9":2,"b":3,"01":4,"4294967294":5,"4294967295":6,"-1":7,"1.5":8,"0":9,"a":0,"9007199254740993":1,"4294967296":2}]',
      ),
    ),
  },
  {
    name: "proto_key",
    note: "a __proto__ member is an ordinary key and is hashed",
    detailsJson: '[{"type":"t","__proto__":{"x":1},"a":2}]',
    request: request(JSON.parse('[{"type":"t","__proto__":{"x":1},"a":2}]')),
  },
  {
    name: "unicode_values",
    note: "non-ASCII text is written as itself, never \\u-escaped",
    request: request([
      { type: "t", label: "café — 東京 \u{1F600}", note: "  " },
    ]),
  },
  {
    name: "escapes",
    note: "quote, backslash, control characters and DEL",
    request: request([
      {
        type: "t",
        text: 'say "hi"\\ \n\t\r\b\f \u0001\u001f \u007f /',
      },
    ]),
  },
  {
    name: "numbers_integers",
    note: "integers, zero, negatives and the safe-integer edge",
    request: request([
      { type: "t", n: [0, 1, -1, 42, 9007199254740991, -9007199254740991] },
    ]),
  },
  {
    name: "numbers_beyond_safe",
    note: "an integer past 2^53 is read as the nearest double, as JSON.parse does, before it is written",
    detailsJson:
      '[{"type":"t","n":[9007199254740993,18446744073709551615,123456789012345678901234567890]}]',
    request: request(
      JSON.parse(
        '[{"type":"t","n":[9007199254740993,18446744073709551615,123456789012345678901234567890]}]',
      ),
    ),
  },
  {
    name: "numbers_fractions_and_exponents",
    note: "ECMAScript Number::toString: shortest digits, exponent only at 1e21 and 1e-7",
    request: request([
      {
        type: "t",
        n: [
          0.5, -0.25, 1.5, 4.35, 0.1, 100.25, 0.000001, 1e-7, 1.5e-7,
          123456789.125, 1e20, 1e21, 1.2345678901234568e20,
          1.7976931348623157e308, 5e-324, -1e-7,
        ],
      },
    ]),
  },
  {
    name: "negative_zero",
    note: "-0 is written 0",
    request: request([{ type: "t", n: -0 }]),
  },
  {
    name: "literals_and_empties",
    note: "true, false, null, empty object and empty array",
    request: request([
      { type: "t", yes: true, no: false, nothing: null, obj: {}, arr: [] },
    ]),
  },
  {
    name: "resource_ref",
    note: "a resourceRef is a field of its own",
    request: request([{ type: "t" }], { resourceRef: "repo:acme/catalog" }),
  },
  {
    name: "length_prefix_left",
    note: "text moved across a field boundary must change the digest: one split",
    request: request([{ type: "t" }], {
      subject: "authorization_request:areq_1",
      approverRef: "inbox_x",
    }),
  },
  {
    name: "length_prefix_right",
    note: "the same bytes split differently between subject and approverRef",
    request: request([{ type: "t" }], {
      subject: "authorization_request:areq_",
      approverRef: "1inbox_x",
    }),
  },
  {
    name: "multibyte_binding_message",
    note: "the length prefix counts UTF-8 bytes, not characters",
    request: request([{ type: "t" }], {
      bindingMessage: "Autoriser l’action « déployer » 東京 \u{1F600}",
    }),
  },
  {
    name: "kind_transaction",
    note: "the kind is hashed: a payment approval must not settle a request",
    request: request([{ type: "t" }], { kind: "transaction_authorization" }),
  },
  {
    name: "other_requester",
    note: "the requester handle is hashed",
    request: request([{ type: "t" }], {
      requesterRef: "req_zzzzzzzzzzzzzzzzzzzzzzzz",
    }),
  },
  {
    name: "other_expiry",
    note: "the approval window is hashed",
    request: request([{ type: "t" }], {
      expiresAt: "2026-09-28T12:05:01.000Z",
    }),
  },
];
