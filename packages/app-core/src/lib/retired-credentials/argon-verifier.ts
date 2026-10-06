/** The selected trap KDF; unrelated hash algorithms are not imported. */
import { argon2id } from "hash-wasm";

export function deriveRetiredVerifier(
  password: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    iterations: 3,
    memorySize: 65536,
    parallelism: 1,
    hashLength: 32,
    outputType: "binary",
  });
}
