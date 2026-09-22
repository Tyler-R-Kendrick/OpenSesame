import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INGRESS_LIMITS,
  type HeaderPair,
  IngressEvidenceError,
  parseClientCertFields,
} from "./index.js";

const CORPUS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "crates",
  "ingress-evidence",
  "fixtures",
);

interface CorpusCase {
  name: string;
  headers: [string, string][];
  limits?: {
    max_certificate_bytes: number;
    max_chain_certificates: number;
    max_total_header_bytes: number;
  };
  expect:
    | { ok: { leaf_sha256: string; intermediates_sha256: string[] } }
    | { error: string };
}

function corpus(file: string): CorpusCase[] {
  return (
    JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")) as {
      cases: CorpusCase[];
    }
  ).cases;
}

const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json"));

describe("shared RFC 9440 corpus", () => {
  it("has the three corpus files", () => {
    expect(files.sort()).toEqual([
      "limits.json",
      "structure.json",
      "valid.json",
    ]);
  });

  for (const file of files) {
    describe(file, () => {
      for (const c of corpus(file)) {
        it(c.name, () => {
          const limits = c.limits
            ? {
                maxCertificateBytes: c.limits.max_certificate_bytes,
                maxChainCertificates: c.limits.max_chain_certificates,
                maxTotalHeaderBytes: c.limits.max_total_header_bytes,
              }
            : DEFAULT_INGRESS_LIMITS;
          const headers: HeaderPair[] = c.headers;
          if ("ok" in c.expect) {
            const chain = parseClientCertFields(headers, limits);
            expect(chain.leafThumbprintSha256).toBe(c.expect.ok.leaf_sha256);
            expect(
              createHash("sha256").update(chain.leafDer).digest("hex"),
            ).toBe(c.expect.ok.leaf_sha256);
            expect(
              chain.intermediatesDer.map((d) =>
                createHash("sha256").update(d).digest("hex"),
              ),
            ).toEqual(c.expect.ok.intermediates_sha256);
          } else {
            let thrown: unknown;
            try {
              parseClientCertFields(headers, limits);
            } catch (err) {
              thrown = err;
            }
            expect(thrown).toBeInstanceOf(IngressEvidenceError);
            expect((thrown as IngressEvidenceError).code).toBe(c.expect.error);
          }
        });
      }
    });
  }
});
