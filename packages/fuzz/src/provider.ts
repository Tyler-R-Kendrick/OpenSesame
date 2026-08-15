/**
 * Jazzer.js-compatible data provider. Targets export `fuzz(data: Buffer)` so
 * `@jazzer.js/core` can drive them when the native addon is available. This
 * local copy keeps unit tests and the local runner off that native binding.
 */
export class FuzzedDataProvider {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  consumeBoolean(): boolean {
    return this.consumeByte() % 2 === 1;
  }

  consumeIntegralInRange(min: number, max: number): number {
    if (max < min) {
      throw new RangeError("max < min");
    }
    const span = max - min + 1;
    return min + (this.consumeUint32() % span);
  }

  consumeString(maxLength: number): string {
    const n = Math.min(Math.max(0, maxLength), this.remaining());
    const slice = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice.toString("utf8");
  }

  consumeRemainingAsString(): string {
    return this.consumeString(this.remaining());
  }

  private consumeByte(): number {
    if (this.offset >= this.data.length) {
      return 0;
    }
    const value = this.data[this.offset] ?? 0;
    this.offset += 1;
    return value;
  }

  private consumeUint32(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      value = ((value << 8) | this.consumeByte()) >>> 0;
    }
    return value;
  }

  private remaining(): number {
    return Math.max(0, this.data.length - this.offset);
  }
}
