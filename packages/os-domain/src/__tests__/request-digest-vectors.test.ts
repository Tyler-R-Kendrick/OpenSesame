import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../crypto/digest.js";
import {
  REQUEST_DIGEST_PURPOSE,
  canonicalRequestDigest,
} from "../crypto/request-digest.js";
import { isJsonObject, isString, overlapCast } from "../json.js";
import { DIGEST_CASES } from "./request-digest-cases.js";

/**
 * `spec/conformance/request-digest-vectors.json` (ADR 0139, ADR 0156).
 *
 * The interaction request digest is computed here by the Identity API and
 * recomputed in Rust by the agent-hooks approver, which refuses an approval
 * whose interaction does not hash to what it sent. Two implementations of one
 * digest are one drift away from an approver that rejects every honest
 * answer, or accepts a wrong one — so the digest is written down once, as
 * vectors, and each side is tested against the file.
 *
 * The expected values are generated from `canonicalRequestDigest`, never
 * typed: `UPDATE_REQUEST_DIGEST_VECTORS=1` rewrites the file, and without it
 * this test fails when the file and the implementation part ways.
 */

const FILE = new URL(
  "../../../../spec/conformance/request-digest-vectors.json",
  import.meta.url,
);

const ABOUT =
  "Interaction request digest vectors (ADR 0086, ADR 0139, ADR 0156). Every digest and canonicalDetails is generated from packages/os-domain crypto/request-digest.ts (UPDATE_REQUEST_DIGEST_VECTORS=1); crates/agent-hooks recomputes them independently. Never edit by hand, and never regenerate to make a reader pass.";

const ENCODING = {
  purpose: REQUEST_DIGEST_PURPOSE,
  fields: [
    "purpose",
    "kind",
    "subject",
    "approverRef",
    "requesterRef",
    "canonicalDetails",
    "bindingMessage",
    "resourceRef (the empty string when absent)",
    "expiresAt",
  ],
  framing:
    "each field is written as its UTF-8 byte length in decimal, one NUL byte, then its UTF-8 bytes; the frames are concatenated in the order above",
  canonicalDetails:
    "the authorizationDetails array as JSON with every object's keys sorted by UTF-16 code unit, recursively, except that keys which are canonical array indices (decimal, no leading zero, at most 4294967294) come first in ascending numeric order, as JSON.stringify walks the sorted object; array order kept; strings written as JSON.stringify writes them; every number read as a double and written as ECMAScript Number::toString (-0 is 0)",
  digest: "sha256:<lowercase hex of the SHA-256 of the concatenated frames>",
};

function buildDocument() {
  return {
    about: ABOUT,
    encoding: ENCODING,
    cases: DIGEST_CASES.map((digestCase) => {
      const { authorizationDetails, ...rest } = digestCase.request;
      return {
        name: digestCase.name,
        note: digestCase.note,
        ...(digestCase.equivalentTo
          ? { equivalentTo: digestCase.equivalentTo }
          : undefined),
        request: digestCase.detailsJson
          ? { ...rest, authorizationDetailsJson: digestCase.detailsJson }
          : { ...rest, authorizationDetails },
        canonicalDetails: canonicalize([...authorizationDetails]),
        digest: canonicalRequestDigest(digestCase.request),
      };
    }),
  };
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}\0`, "utf8"), bytes]);
}

if (process.env.UPDATE_REQUEST_DIGEST_VECTORS === "1") {
  writeFileSync(FILE, `${JSON.stringify(buildDocument(), null, 2)}\n`);
}

const committed = overlapCast(JSON.parse(readFileSync(FILE, "utf8")));

describe("request digest vectors", () => {
  it("drift: the committed vectors are what canonicalRequestDigest computes", () => {
    // Round-tripped, so it compares the way the file reads.
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildDocument())));
  });

  it("every case is recomputed from the file's own fields with the documented framing", () => {
    if (!isJsonObject(committed) || !Array.isArray(committed.cases)) {
      throw new Error("vector file is not shaped as expected");
    }
    for (const entry of committed.cases) {
      if (!isJsonObject(entry) || !isJsonObject(entry.request)) {
        throw new Error("vector case is not shaped as expected");
      }
      const request = entry.request;
      const details = isString(request.authorizationDetailsJson)
        ? JSON.parse(request.authorizationDetailsJson)
        : request.authorizationDetails;
      const canonical = canonicalize(details);
      expect(canonical, String(entry.name)).toBe(entry.canonicalDetails);
      const fields = [
        REQUEST_DIGEST_PURPOSE,
        String(request.kind),
        String(request.subject),
        String(request.approverRef),
        String(request.requesterRef),
        canonical,
        String(request.bindingMessage),
        isString(request.resourceRef) ? request.resourceRef : "",
        String(request.expiresAt),
      ];
      const digest = createHash("sha256")
        .update(Buffer.concat(fields.map(frame)))
        .digest("hex");
      expect(`sha256:${digest}`, String(entry.name)).toBe(entry.digest);
    }
  });

  it("distinct requests never share a digest; declared equivalents always do", () => {
    const document = buildDocument();
    const byName = new Map(document.cases.map((c) => [c.name, c.digest]));
    const seen = new Map<string, string>();
    for (const digestCase of document.cases) {
      expect(digestCase.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      if (digestCase.equivalentTo) {
        expect(digestCase.digest).toBe(byName.get(digestCase.equivalentTo));
        continue;
      }
      const clash = seen.get(digestCase.digest);
      expect(
        clash,
        `${digestCase.name} collides with ${clash}`,
      ).toBeUndefined();
      seen.set(digestCase.digest, digestCase.name);
    }
  });
});
