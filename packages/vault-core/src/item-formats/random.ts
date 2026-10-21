/** Unbiased draws for synthetic format values; tests may inject the bytes. */
export type RandomBytes = (length: number) => Uint8Array;

function secureBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** The smallest source every generated item format uses. */
export class Random {
  readonly #bytes: RandomBytes;

  constructor(bytes: RandomBytes = secureBytes) {
    this.#bytes = bytes;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0)
      throw new RangeError("random byte length must be a non-negative integer");
    return this.#bytes(length);
  }

  int(max: number): number {
    if (!Number.isSafeInteger(max) || max <= 0 || max > 0x1_0000_0000)
      throw new RangeError("random bound must be in [1, 2^32]");
    // Rejection sampling keeps every character and digit uniform.
    const limit = Math.floor(0x1_0000_0000 / max) * max;
    for (;;) {
      const bytes = this.bytes(4);
      const value =
        ((bytes[0] ?? 0) * 0x1_000000 +
          (bytes[1] ?? 0) * 0x1_0000 +
          (bytes[2] ?? 0) * 0x100 +
          (bytes[3] ?? 0)) >>>
        0;
      if (value < limit) return value % max;
    }
  }

  pick(alphabet: string): string {
    return alphabet.charAt(this.int(alphabet.length));
  }

  string(alphabet: string, length: number): string {
    let out = "";
    for (let index = 0; index < length; index += 1) out += this.pick(alphabet);
    return out;
  }

  hex(length: number): string {
    return this.string("0123456789abcdef", length);
  }

  digits(length: number): string {
    return this.string("0123456789", length);
  }
}
