/**
 * The Argon2 bridge kdbxweb needs before a database can open.
 *
 * kdbxweb ships without an Argon2 implementation and hash-wasm supplies the
 * primitive; `loadCodec` in `./kdbx.js` registers what `cappedArgon2Impl`
 * builds here.
 *
 * Every KDF parameter arrives from the database header, so whoever wrote the
 * file chose them, and kdbxweb validates only their lower bounds. They are
 * capped before hash-wasm sees them: KeePassXC's own defaults are 64 MiB of
 * memory, 3 iterations and 4 lanes. Higher work factors can be legitimate,
 * but this interactive importer refuses them rather than letting a file
 * request unbounded work. The combined budget matters even when each
 * individual parameter fits.
 */

export class KdbxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KdbxImportError";
  }
}

const MAX_ARGON2_MEMORY_KIB = 64 * 1024;
const MAX_ARGON2_ITERATIONS = 10;
const MAX_ARGON2_PARALLELISM = 4;
const MAX_ARGON2_WORK_KIB = MAX_ARGON2_MEMORY_KIB * 3;

type Argon2Options = Parameters<typeof import("hash-wasm").argon2d>[0] & {
  outputType: "binary";
};
type Argon2 = (options: Argon2Options) => Promise<Uint8Array>;

/** The positional signature `CryptoEngine.setArgon2Impl` calls. */
export type Argon2Impl = (
  ...args: [
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: number,
    version: number,
  ]
) => Promise<ArrayBuffer>;

/**
 * `hashWasm` and kdbxweb's argon2id type discriminator come from the caller,
 * so this module carries neither heavy import and can be tested with a stub.
 */
export function cappedArgon2Impl(
  hashWasm: { argon2d: Argon2; argon2id: Argon2 },
  argon2idType: number,
): Argon2Impl {
  return async (
    ...[password, salt, memory, iterations, length, parallelism, type, version]
  ) => {
    if (version !== 0x13) {
      throw new KdbxImportError(
        "This database uses Argon2 version 1.0, which this importer cannot compute. Open it in KeePassXC and save it again to upgrade the key derivation.",
      );
    }
    if (
      ![memory, iterations, parallelism, length].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      length !== 32 ||
      memory < 8 * parallelism ||
      memory > MAX_ARGON2_MEMORY_KIB ||
      iterations > MAX_ARGON2_ITERATIONS ||
      parallelism > MAX_ARGON2_PARALLELISM ||
      memory * iterations > MAX_ARGON2_WORK_KIB
    ) {
      throw new KdbxImportError(
        "This database's Argon2 parameters exceed this importer's supported work budget. Open it in KeePassXC and save a copy using at most 64 MiB of memory, 3 iterations and 4 lanes before importing.",
      );
    }
    const argon2 = type === argon2idType ? hashWasm.argon2id : hashWasm.argon2d;
    // kdbxweb has already converted the header's byte count to KiB, which is
    // the unit hash-wasm takes.
    const hash = await argon2({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      parallelism,
      iterations,
      memorySize: memory,
      hashLength: length,
      outputType: "binary",
    });
    return new Uint8Array(hash).buffer;
  };
}
