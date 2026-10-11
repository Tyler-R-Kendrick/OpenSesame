/** Fixed original bound AES-GCM DATA operations only, compatible with existing vault seals. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type SealedBlob,
  VaultCorruptError,
  b64ToBytes,
  bytesToB64,
} from "@opensesame/vault-core";
const LIMIT = 1024 * 1024;
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
function fixedSealMethods(
  installed: Crypto,
  subtle: SubtleCrypto,
  random: Crypto["getRandomValues"],
  encrypt: SubtleCrypto["encrypt"],
  decrypt: SubtleCrypto["decrypt"],
) {
  // The retained native bind verifies callability without reading a slot's bind property.
  const fixedRandom: Crypto["getRandomValues"] = bindOriginal(
    random,
    installed,
  );
  const fixedEncrypt: SubtleCrypto["encrypt"] = bindOriginal(encrypt, subtle);
  const fixedDecrypt: SubtleCrypto["decrypt"] = bindOriginal(decrypt, subtle);
  return { fixedRandom, fixedEncrypt, fixedDecrypt };
}
class OriginalDeviceIdentitySealData {
  readonly #original: () => void;
  readonly #installed: Crypto;
  readonly #subtle: SubtleCrypto;
  readonly #random: Crypto["getRandomValues"];
  readonly #encrypt: SubtleCrypto["encrypt"];
  readonly #decrypt: SubtleCrypto["decrypt"];
  readonly #fixed: ReturnType<typeof fixedSealMethods>;
  #live = true;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #calls = new Set<Promise<unknown>>();
  constructor(original: () => void) {
    original();
    this.#original = original;
    this.#installed = crypto;
    this.#subtle = this.#installed.subtle;
    this.#random = this.#installed.getRandomValues;
    this.#encrypt = this.#subtle.encrypt;
    this.#decrypt = this.#subtle.decrypt;
    this.#check();
    this.#fixed = fixedSealMethods(
      this.#installed,
      this.#subtle,
      this.#random,
      this.#encrypt,
      this.#decrypt,
    );
    Object.freeze(this);
  }
  #check = () => {
    this.#original();
    if (
      !this.#live ||
      crypto !== this.#installed ||
      this.#installed.subtle !== this.#subtle ||
      this.#installed.getRandomValues !== this.#random ||
      this.#subtle.encrypt !== this.#encrypt ||
      this.#subtle.decrypt !== this.#decrypt
    )
      throw new Error("Original identity seal transport retired.");
  };
  #accept = <T>(
    work: () => Promise<T>,
    discard?: (value: T) => void,
  ): Promise<T> => {
    const task = Promise.resolve().then(async () => {
      this.#check();
      const value = await work();
      try {
        this.#check();
      } catch (error) {
        discard?.(value);
        throw error;
      }
      return value;
    });
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  };
  #track = <T>(work: () => Promise<T>): Promise<T> => {
    // Reserve before original callbacks or input accessors can reenter close.
    // Then invoke synchronously to own inputs before their first await.
    let deliver!: (value: T) => void;
    let refuse!: (cause: unknown) => void;
    const completion = new Promise<T>((resolve, reject) => {
      deliver = resolve;
      refuse = reject;
    });
    this.#calls.add(completion);
    const task = (async () => {
      this.#check();
      const value = await work();
      this.#check();
      return value;
    })();
    void task.then(deliver, refuse);
    void completion.then(
      () => this.#calls.delete(completion),
      () => this.#calls.delete(completion),
    );
    return completion;
  };
  #sealWork = async (
    key: CryptoKey,
    input: BoundaryValue,
    binding: string,
  ): Promise<SealedBlob> => {
    this.#check();
    if (!binding || binding.length > 1024)
      throw new Error("Original identity seal binding unavailable.");
    const plain = new TextEncoder().encode(JSON.stringify(input));
    try {
      if (plain.length > LIMIT)
        throw new Error("Original identity seal exceeds its bound.");
      const aad = new TextEncoder().encode(binding);
      this.#check();
      const iv = this.#fixed.fixedRandom(new Uint8Array(12));
      this.#check();
      const cipher = await this.#accept(() =>
        this.#fixed.fixedEncrypt(
          { name: "AES-GCM", iv: iv.buffer, additionalData: aad.buffer },
          key,
          plain.buffer,
        ),
      );
      this.#check();
      return {
        ivB64: bytesToB64(iv),
        ctB64: bytesToB64(new Uint8Array(cipher)),
      };
    } finally {
      plain.fill(0);
    }
  };
  #openWork = async (
    key: CryptoKey,
    input: SealedBlob,
    binding: string,
  ): Promise<BoundaryValue> => {
    this.#check();
    const blob = { ivB64: input.ivB64, ctB64: input.ctB64 };
    if (
      !binding ||
      binding.length > 1024 ||
      blob.ivB64.length > 32 ||
      blob.ctB64.length > LIMIT * 2
    )
      throw new VaultCorruptError("identity seal exceeds its bound");
    const iv = new Uint8Array(b64ToBytes(blob.ivB64));
    const cipher = new Uint8Array(b64ToBytes(blob.ctB64));
    const aad = new TextEncoder().encode(binding);
    let opened: Uint8Array | undefined;
    try {
      opened = await this.#accept(
        async () =>
          new Uint8Array(
            await this.#fixed.fixedDecrypt(
              { name: "AES-GCM", iv: iv.buffer, additionalData: aad.buffer },
              key,
              cipher.buffer,
            ),
          ),
        (bytes) => bytes.fill(0),
      );
      if (opened.length > LIMIT)
        throw new VaultCorruptError("identity seal exceeds its bound");
      const value: BoundaryValue = JSON.parse(new TextDecoder().decode(opened));
      this.#check();
      return value;
    } finally {
      opened?.fill(0);
    }
  };
  port() {
    return Object.freeze({
      check: this.#check,
      seal: (key: CryptoKey, input: BoundaryValue, binding: string) =>
        this.#track(() => this.#sealWork(key, input, binding)),
      open: (key: CryptoKey, input: SealedBlob, binding: string) =>
        this.#track(() => this.#openWork(key, input, binding)),
      identities: Object.freeze([
        this.#installed,
        this.#subtle,
        this.#random,
        this.#encrypt,
        this.#decrypt,
      ]),
      close: async () => {
        this.#live = false;
        const results = await Promise.allSettled([
          ...new Set([...this.#calls, ...this.#pending]),
        ]);
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length)
          throw new AggregateError(
            errors,
            "Original identity seals refused after accepted work drain.",
          );
      },
    });
  }
}
/** Private identity producer captures this before queueing; no storage or authentication permission is issued. */
export function captureOriginalDeviceIdentitySealData(original: () => void) {
  return new OriginalDeviceIdentitySealData(original).port();
}
