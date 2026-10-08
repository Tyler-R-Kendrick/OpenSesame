import {
  MAX_PBKDF2_ITERATIONS,
  VaultCorruptError,
} from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  PIN_PBKDF2_ITERATIONS,
  assertPinKdfIterations,
  pinPbkdf2Iterations,
} from "./pin-kdf.js";

const PIN = "48291037";
const SALT_B64 = "OUapxavzr9ceLRqziWzQ3A==";

describe("assertPinKdfIterations", () => {
  it("grandfathers wraps at the legacy floor for short digit PINs", () => {
    expect(() =>
      assertPinKdfIterations(
        {
          alg: "PBKDF2-SHA256",
          saltB64: SALT_B64,
          iterations: PIN_PBKDF2_ITERATIONS,
        },
        PIN,
      ),
    ).not.toThrow();
  });

  it("accepts scaled metadata and rejects a partial downgrade", () => {
    const required = pinPbkdf2Iterations(PIN);
    expect(required).toBe(MAX_PBKDF2_ITERATIONS);
    expect(() =>
      assertPinKdfIterations(
        {
          alg: "PBKDF2-SHA256",
          saltB64: SALT_B64,
          iterations: required,
        },
        PIN,
      ),
    ).not.toThrow();
    expect(() =>
      assertPinKdfIterations(
        {
          alg: "PBKDF2-SHA256",
          saltB64: SALT_B64,
          iterations: PIN_PBKDF2_ITERATIONS + 1,
        },
        PIN,
      ),
    ).toThrow(VaultCorruptError);
  });
});
