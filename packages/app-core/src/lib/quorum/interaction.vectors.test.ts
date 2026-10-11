/**
 * The interaction digest `D_i` against the shared vectors (ADR 0139). The file
 * is the definition: os-domain generates it from `canonicalRequestDigest` and
 * the Rust agent-hooks approver reproduces it; this is a third reader, so a
 * quorum interaction's digest is one an Identity API or an executor would
 * compute for the same fields. Nothing here regenerates the file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonObject, canonicalize } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { interactionRequestDigest } from "./interaction-envelope.js";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../spec/conformance/request-digest-vectors.json",
);

const VectorsSchema = z.object({
  encoding: z.object({ purpose: z.string() }),
  cases: z.array(
    z.object({
      name: z.string(),
      request: z.object({
        kind: z.string(),
        subject: z.string(),
        approverRef: z.string(),
        requesterRef: z.string(),
        bindingMessage: z.string(),
        resourceRef: z.string().optional(),
        expiresAt: z.string(),
        authorizationDetails: z.array(z.custom<JsonObject>()).optional(),
        authorizationDetailsJson: z.string().optional(),
      }),
      canonicalDetails: z.string(),
      digest: z.string(),
    }),
  ),
});

const vectors = VectorsSchema.parse(JSON.parse(readFileSync(FILE, "utf8")));

/** Read the way every reader must: a case about how text is read carries the literal. */
function detailsOf(request: (typeof vectors.cases)[number]["request"]) {
  if (request.authorizationDetailsJson !== undefined) {
    return z
      .array(z.custom<JsonObject>())
      .parse(JSON.parse(request.authorizationDetailsJson));
  }
  return request.authorizationDetails ?? [];
}

type Vector = (typeof vectors.cases)[number];

function reproduce(entry: Vector): void {
  const r = entry.request;
  const details = detailsOf(r);
  expect(canonicalize([...details])).toBe(entry.canonicalDetails);
  const digest = interactionRequestDigest({
    kind: r.kind,
    subject: r.subject,
    approverRef: r.approverRef,
    requesterRef: r.requesterRef,
    authorizationDetails: details,
    bindingMessage: r.bindingMessage,
    resourceRef: r.resourceRef,
    expiresAt: r.expiresAt,
  });
  expect(digest).toBe(entry.digest);
}

describe("the interaction digest against the shared vectors", () => {
  it("names the purpose this module frames under", () => {
    expect(vectors.encoding.purpose).toBe("opensesame:interaction-request:v1");
    expect(vectors.cases.length).toBeGreaterThan(20);
  });

  // Including `proto_key`: os-domain's browser canonicalize once assigned
  // `out[key]`, so an own `__proto__` key fell out of the text. It defines the
  // property now, as the node twin does, and this case holds it there.
  it.each(vectors.cases.map((c) => [c.name, c] as const))(
    "reproduces %s byte for byte",
    (_name, entry) => {
      reproduce(entry);
    },
  );
});
