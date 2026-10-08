import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { EMPTY_PAYLOAD, signS3 } from "./s3-sigv4.js";

// The worked examples in Amazon's "Signature Calculations for the
// Authorization Header" for S3: a signer that matches them signs for S3.
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: Redacted.make("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
};
const now = new Date("2013-05-24T00:00:00Z");

describe("SigV4 for S3", () => {
  it("signs Amazon's GET Object example, range header included", () => {
    const { headers } = signS3({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: new Headers({ range: "bytes=0-9" }),
      payloadHash: EMPTY_PAYLOAD,
      region: "us-east-1",
      credentials,
      now,
    });
    expect(headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs Amazon's PUT Object example, with a name that needs encoding", () => {
    const body = new TextEncoder().encode("Welcome to Amazon S3.");
    const { headers, url } = signS3({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: new Headers({
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      }),
      payloadHash: bytesToHex(sha256(body)),
      region: "us-east-1",
      credentials,
      now,
    });
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/test%24file.text");
    expect(headers.get("authorization")).toContain(
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("signs Amazon's List Objects example, query sorted and encoded", () => {
    const { headers, url } = signS3({
      method: "GET",
      url: new URL(
        "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      ),
      payloadHash: EMPTY_PAYLOAD,
      region: "us-east-1",
      credentials,
      now,
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
    );
    expect(headers.get("authorization")).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  it("carries a session token as a signed header and never sends host", () => {
    const { headers } = signS3({
      method: "GET",
      url: new URL("https://s3.test/bucket/a.json"),
      payloadHash: EMPTY_PAYLOAD,
      region: "eu-west-1",
      credentials: { ...credentials, sessionToken: Redacted.make("tok") },
      now,
    });
    expect(headers.get("x-amz-security-token")).toBe("tok");
    expect(headers.get("authorization")).toContain("x-amz-security-token");
    expect(headers.has("host")).toBe(false);
  });
});
