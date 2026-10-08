/** Real fixed-cost Argon2 vectors. No KDF mock or authority fixture. */
import { expect, it } from "vitest";
import {
  deriveRetiredVerifier as derive,
  verifyRetiredPassword as verify,
} from "./argon-verifier.js";
import vectors from "./protocol-vectors.json";

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

it("derives and verifies all real shared vectors without normalizing Unicode", async () => {
  for (const vector of vectors.vectors) {
    const salt = decode(vector.saltB64);
    const expected = decode(vector.verifierB64);
    expect(await derive(vector.password, salt)).toBe(vector.verifierB64);
    expect(await verify(vector.password, salt, expected)).toBe(true);
  }
});

it("refuses a wrong password and wrong salt against genuine Argon2 bytes", async () => {
  const vector = vectors.vectors[0];
  if (!vector) throw new Error("Missing shared vector.");
  const salt = decode(vector.saltB64);
  const expected = decode(vector.verifierB64);
  expect(await verify(`${vector.password} `, salt, expected)).toBe(false);
  const first = salt[0];
  if (first === undefined) throw new Error("Missing salt byte.");
  salt[0] = first ^ 1;
  expect(await verify(vector.password, salt, expected)).toBe(false);
  const decomposed = vectors.vectors.find(
    (entry) => entry.name === "decomposed",
  );
  if (!decomposed) throw new Error("Missing decomposed vector.");
  expect(
    await verify(
      "é",
      decode(decomposed.saltB64),
      decode(decomposed.verifierB64),
    ),
  ).toBe(false);
});
