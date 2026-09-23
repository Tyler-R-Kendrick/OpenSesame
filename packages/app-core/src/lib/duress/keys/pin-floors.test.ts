import { describe, expect, it } from "vitest";
import { MAX_PBKDF2_ITERATIONS } from "../../vault/crypto.js";
import { PIN_PBKDF2_ITERATIONS } from "../../vault/unlock-methods.js";
import {
  DURESS_PIN_PBKDF2_ITERATIONS,
  DURESS_PIN_PBKDF2_ITERATIONS_MAX,
  DuressKdfError,
  assertDuressCodeLength,
  assertDuressKdfIterations,
  assertDuressKdfParams,
} from "./pin-floors.js";

describe("KEYS-D PIN KDF floors", () => {
  it("matches vault PIN floor and ceiling", () => {
    expect(DURESS_PIN_PBKDF2_ITERATIONS).toBe(PIN_PBKDF2_ITERATIONS);
    expect(DURESS_PIN_PBKDF2_ITERATIONS).toBe(1_200_000);
    expect(DURESS_PIN_PBKDF2_ITERATIONS_MAX).toBe(MAX_PBKDF2_ITERATIONS);
  });

  it("rejects short/non-digit codes", () => {
    expect(() => assertDuressCodeLength("1234567")).toThrow(DuressKdfError);
    expect(() => assertDuressCodeLength("abcdefgh")).toThrow(DuressKdfError);
    assertDuressCodeLength("01234567");
  });

  it("rejects malicious KDF metadata before derive", () => {
    expect(() => assertDuressKdfIterations(600_000)).toThrow(/below PIN floor/);
    expect(() => assertDuressKdfIterations(MAX_PBKDF2_ITERATIONS + 1)).toThrow(
      /unbounded/,
    );
    expect(() =>
      assertDuressKdfParams({
        iterations: DURESS_PIN_PBKDF2_ITERATIONS,
        saltB64: btoa("short"),
      }),
    ).toThrow(/wrong size/);
  });
});
