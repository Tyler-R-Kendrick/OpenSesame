import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Package-level residual gaps for duress redteam.
 */
import { describe, expect, it } from "vitest";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

describe("tests/redteam duress integration gaps", () => {
  it("GAP-PEER-CRYPTO: receiver verify must call WebCrypto-equivalent ECDSA check", () => {
    const verify = join(
      root,
      "apps",
      "daemon",
      "src",
      "duress_receiver",
      "verify.rs",
    );
    expect(existsSync(verify)).toBe(true);
    const body = readFileSync(verify, "utf8");
    // Structural verify alone is insufficient — crypto verify must be wired (PEER-to-HOST).
    const hasCryptoVerify =
      /verifying_key|VerifyingKey|p256::|ecdsa::|signature::Verifier/i.test(
        body,
      ) && /verify\(/i.test(body);
    expect(
      hasCryptoVerify,
      "duress_receiver verify.rs lacks ECDSA verify — see PEER-to-HOST.md / REDTEAM-to-HOST-receiver.md",
    ).toBe(true);
  });
});
