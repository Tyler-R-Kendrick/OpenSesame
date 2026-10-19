/** Inactive exact-byte verifier. A match conveys no owner or vault authority. */
import { passwordBytes } from "./password-bytes.js";
export { MAX_PASSWORD_BYTES, passwordBytes } from "./password-bytes.js";

let busy = false;
export interface RetiredKdfWork {
  derive(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
}
export interface RetiredVerifier {
  derive(password: string, salt: Uint8Array): Promise<string>;
  verify(
    password: string,
    salt: Uint8Array,
    expected: Uint8Array,
  ): Promise<boolean>;
}

/** Fixed 32-iteration comparison for valid lengths; no JS timing guarantee. */
export function equalVerifierBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (
    !(left instanceof Uint8Array) ||
    !(right instanceof Uint8Array) ||
    left.length !== 32 ||
    right.length !== 32
  )
    return false;
  const leftView = new DataView(left.buffer, left.byteOffset, 32);
  const rightView = new DataView(right.buffer, right.byteOffset, 32);
  let difference = 0;
  for (let i = 0; i < 32; i++)
    difference |= leftView.getUint8(i) ^ rightView.getUint8(i);
  return difference === 0;
}

async function withDerived<T>(
  password: string,
  salt: Uint8Array,
  consume: (bytes: Uint8Array) => T,
  work: RetiredKdfWork,
): Promise<T> {
  if (busy)
    throw new Error("A retired credential derivation is already running.");
  busy = true;
  let encoded: Uint8Array | undefined;
  let ownSalt: Uint8Array | undefined;
  let derived: Uint8Array | undefined;
  try {
    if (!(salt instanceof Uint8Array) || salt.length !== 16)
      throw new Error("Invalid retired credential salt.");
    encoded = passwordBytes(password);
    ownSalt = new Uint8Array(salt);
    derived = await work.derive(encoded, ownSalt);
    if (!(derived instanceof Uint8Array) || derived.length !== 32)
      throw new Error("Invalid retired credential derivation.");
    return consume(derived);
  } finally {
    try {
      encoded?.fill(0);
      ownSalt?.fill(0);
      if (derived instanceof Uint8Array) derived.fill(0);
    } finally {
      busy = false;
    }
  }
}

/** Trusted physical KDF port only; callers cannot replace the default instance. */
export function createRetiredVerifier(work: RetiredKdfWork): RetiredVerifier {
  return {
    derive: (password, salt) =>
      withDerived(
        password,
        salt,
        (derived) => btoa(String.fromCharCode(...derived)),
        work,
      ),
    verify: async (password, salt, expected) => {
      if (!(expected instanceof Uint8Array) || expected.length !== 32)
        throw new Error("Invalid retired credential verifier.");
      const ownExpected = new Uint8Array(expected);
      try {
        return await withDerived(
          password,
          salt,
          (derived) => equalVerifierBytes(derived, ownExpected),
          work,
        );
      } finally {
        ownExpected.fill(0);
      }
    },
  };
}
/** Persistent verifier permits offline guessing; this is the fixed real adapter. */
export const { derive: deriveRetiredVerifier, verify: verifyRetiredPassword } =
  createRetiredVerifier({
    derive: async (password, salt) =>
      (await import("hash-wasm")).argon2id({
        password,
        salt,
        iterations: 3,
        memorySize: 65536,
        parallelism: 1,
        hashLength: 32,
        outputType: "binary",
      }),
  });
