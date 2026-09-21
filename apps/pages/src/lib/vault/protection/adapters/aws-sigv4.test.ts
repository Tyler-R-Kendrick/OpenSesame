import { describe, expect, it } from "vitest";
import { signAwsKmsJsonPost } from "./aws-sigv4.js";

describe("aws-sigv4", () => {
  it("produces authorization for a KMS encrypt post", async () => {
    const signed = await signAwsKmsJsonPost({
      region: "us-east-1",
      target: "TrentService.Encrypt",
      body: {
        KeyId:
          "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
        Plaintext: "YQ==",
      },
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(signed.url).toBe("https://kms.us-east-1.amazonaws.com/");
    expect(signed.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(signed.headers["x-amz-target"]).toBe("TrentService.Encrypt");
  });
});
