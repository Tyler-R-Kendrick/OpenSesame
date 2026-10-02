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
 * memory, 3 iterations and 4 lanes, so a header past the bounds below
 * describes no real database, and computing one would allocate gigabytes of
 * WASM memory or block the tab on its iterations before the password could
 * even be checked — the tab lock-up the pipeline's own size guard exists to
 * prevent.
 */

export class KdbxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KdbxImportError";
  }
}

const MAX_ARGON2_MEMORY_KIB = 1024 * 1024;
const MAX_ARGON2_ITERATIONS = 1000;
const MAX_ARGON2_PARALLELISM = 16;

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
      memory > MAX_ARGON2_MEMORY_KIB ||
      iterations > MAX_ARGON2_ITERATIONS ||
      parallelism > MAX_ARGON2_PARALLELISM
    ) {
      throw new KdbxImportError(
        "This database's Argon2 parameters are implausibly large, and computing them would exhaust this tab before the password could even be checked. Open it in KeePassXC and lower the key derivation parameters.",
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
