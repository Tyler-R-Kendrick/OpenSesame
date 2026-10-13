/** Fixed original bound AES-GCM DATA operations only, compatible with existing vault seals. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type SealedBlob,
  VaultCorruptError,
  b64ToBytes,
  bytesToB64,
} from "@opensesame/vault-core";
import { OriginalAcceptedWorkFailures } from "../vault/original-accepted-work-failures-data.js";
const originalNativeCall = Function.prototype.call.bind(
  Function.prototype.call,
);
type OriginalCanaryRandomInput = Parameters<Crypto["getRandomValues"]>[0];
const callOriginalRandom: <T extends OriginalCanaryRandomInput>(
  method: Crypto["getRandomValues"],
  receiver: Crypto,
  array: T,
) => T = originalNativeCall;
const callOriginalEncrypt: (
  method: SubtleCrypto["encrypt"],
  receiver: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["encrypt"]>[0],
  key: Parameters<SubtleCrypto["encrypt"]>[1],
  data: Parameters<SubtleCrypto["encrypt"]>[2],
) => ReturnType<SubtleCrypto["encrypt"]> = originalNativeCall;
const callOriginalDecrypt: (
  method: SubtleCrypto["decrypt"],
  receiver: SubtleCrypto,
  algorithm: Parameters<SubtleCrypto["decrypt"]>[0],
  key: Parameters<SubtleCrypto["decrypt"]>[1],
  data: Parameters<SubtleCrypto["decrypt"]>[2],
) => ReturnType<SubtleCrypto["decrypt"]> = originalNativeCall;
const LIMIT = 8 << 20;
type OriginalCanaryWorkResult<T> = Readonly<{ value: T }>;
/** Complete only after the original work and independent native byte cleanup settle. */
function completeOriginalCanaryWork<T>(
  result: OriginalCanaryWorkResult<T> | undefined,
  failure: ErrorOptions | undefined,
  bytes: Uint8Array | undefined,
): T {
  const failures = new OriginalAcceptedWorkFailures(
    "Original canary work and byte cleanup failed.",
  );
  if (failure) failures.record(failure.cause);
  try {
    bytes?.fill(0);
  } catch (cause) {
    failures.record(cause);
  }
  failures.throwIfAny();
  if (result === undefined)
    throw new Error("Original canary work did not deliver.");
  return result.value;
}
/** One fixed original native AES provider; no storage, Root or session permission. */
class OriginalCanaryIndexedSeal {
  readonly installed: Crypto;
  readonly subtle: SubtleCrypto;
  readonly random: Crypto["getRandomValues"];
  readonly encrypt: SubtleCrypto["encrypt"];
  readonly decrypt: SubtleCrypto["decrypt"];
  readonly fixedRandom: Crypto["getRandomValues"];
  readonly fixedEncrypt: SubtleCrypto["encrypt"];
  readonly fixedDecrypt: SubtleCrypto["decrypt"];
  live = true;
  pending = new Set<Promise<unknown>>();
  calls = new Set<Promise<unknown>>();
  closing: Promise<void> | undefined;
  constructor(readonly original: () => void) {
    original();
    this.installed = crypto;
    this.subtle = this.installed.subtle;
    this.random = this.installed.getRandomValues;
    this.encrypt = this.subtle.encrypt;
    this.decrypt = this.subtle.decrypt;
    const installed = this.installed;
    const subtle = this.subtle;
    const random = this.random;
    const encrypt = this.encrypt;
    const decrypt = this.decrypt;
    this.fixedRandom = (array) => callOriginalRandom(random, installed, array);
    this.fixedEncrypt = (algorithm, key, data) =>
      callOriginalEncrypt(encrypt, subtle, algorithm, key, data);
    this.fixedDecrypt = (algorithm, key, data) =>
      callOriginalDecrypt(decrypt, subtle, algorithm, key, data);
    this.check();
  }
  check = () => {
    try {
      this.original();
      if (
        !this.live ||
        crypto !== this.installed ||
        this.installed.subtle !== this.subtle ||
        this.installed.getRandomValues !== this.random ||
        this.subtle.encrypt !== this.encrypt ||
        this.subtle.decrypt !== this.decrypt
      )
        throw new Error("Original canary indexed seal retired.");
      this.original();
      if (!this.live) throw new Error("Original canary indexed seal retired.");
    } catch (error) {
      this.live = false;
      throw error;
    }
  };
  accept<T>(work: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
    const task = Promise.resolve().then(async () => {
      this.check();
      const value = await work();
      try {
        this.check();
      } catch (error) {
        const failures = new OriginalAcceptedWorkFailures(
          "Original canary retirement and discard failed.",
        );
        failures.record(error);
        try {
          discard?.(value);
        } catch (cause) {
          failures.record(cause);
        }
        failures.throwIfAny();
        throw error;
      }
      return value;
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  track<T>(work: () => Promise<T>): Promise<T> {
    // Reserve before original callbacks or input accessors can reenter close.
    // Then invoke synchronously to own inputs before their first await.
    let deliver!: (value: T) => void;
    let refuse!: <Cause>(error: Cause) => void;
    const completion = new Promise<T>((resolve, reject) => {
      deliver = resolve;
      refuse = reject;
    });
    this.calls.add(completion);
    const task = (async () => {
      this.check();
      const value = await work();
      this.check();
      return value;
    })();
    void task.then(deliver, refuse);
    void completion.then(
      () => this.calls.delete(completion),
      () => this.calls.delete(completion),
    );
    return completion;
  }
  async sealWork(
    key: CryptoKey,
    input: BoundaryValue,
    binding: string,
  ): Promise<SealedBlob> {
    this.check();
    if (!binding || binding.length > 1024)
      throw new Error("Original canary indexed seal binding unavailable.");
    const plain = new TextEncoder().encode(JSON.stringify(input));
    let result: OriginalCanaryWorkResult<SealedBlob> | undefined;
    let failure: ErrorOptions | undefined;
    try {
      if (plain.length > LIMIT)
        throw new Error("Original canary indexed seal exceeds its bound.");
      const aad = new TextEncoder().encode(binding);
      this.check();
      const iv = this.fixedRandom(new Uint8Array(12));
      this.check();
      const cipher = await this.accept(() =>
        this.fixedEncrypt(
          { name: "AES-GCM", iv: iv.buffer, additionalData: aad.buffer },
          key,
          plain.buffer,
        ),
      );
      this.check();
      result = {
        value: {
          ivB64: bytesToB64(iv),
          ctB64: bytesToB64(new Uint8Array(cipher)),
        },
      };
    } catch (cause) {
      failure = { cause };
    }
    return completeOriginalCanaryWork(result, failure, plain);
  }
  async openWork(
    key: CryptoKey,
    input: SealedBlob,
    binding: string,
  ): Promise<BoundaryValue> {
    this.check();
    const blob = { ivB64: input.ivB64, ctB64: input.ctB64 };
    if (
      !binding ||
      binding.length > 1024 ||
      blob.ivB64.length > 32 ||
      blob.ctB64.length > LIMIT * 2
    )
      throw new VaultCorruptError("canary indexed seal exceeds its bound");
    const iv = new Uint8Array(b64ToBytes(blob.ivB64));
    const cipher = new Uint8Array(b64ToBytes(blob.ctB64));
    const aad = new TextEncoder().encode(binding);
    let opened: Uint8Array | undefined;
    let result: OriginalCanaryWorkResult<BoundaryValue> | undefined;
    let failure: ErrorOptions | undefined;
    try {
      opened = await this.accept(
        async () =>
          new Uint8Array(
            await this.fixedDecrypt(
              { name: "AES-GCM", iv: iv.buffer, additionalData: aad.buffer },
              key,
              cipher.buffer,
            ),
          ),
        (bytes) => bytes.fill(0),
      );
      if (opened.length > LIMIT)
        throw new VaultCorruptError("canary indexed seal exceeds its bound");
      const value: BoundaryValue = JSON.parse(new TextDecoder().decode(opened));
      this.check();
      result = { value };
    } catch (cause) {
      failure = { cause };
    }
    return completeOriginalCanaryWork(result, failure, opened);
  }
  seal = (key: CryptoKey, input: BoundaryValue, binding: string) =>
    this.track(() => this.sealWork(key, input, binding));
  open = (key: CryptoKey, input: SealedBlob, binding: string) =>
    this.track(() => this.openWork(key, input, binding));
  close = () => {
    if (this.closing) return this.closing;
    this.live = false;
    this.closing = this.drain();
    return this.closing;
  };
  async drain() {
    const results = await Promise.allSettled([
      ...new Set([...this.calls, ...this.pending]),
    ]);
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(
        errors,
        "Original canary seals refused after accepted work drain.",
      );
  }
}
export function captureOriginalCanaryIndexedSealData(original: () => void) {
  const owned = new OriginalCanaryIndexedSeal(original);
  return Object.freeze({
    check: owned.check,
    seal: owned.seal,
    open: owned.open,
    close: owned.close,
  });
}
export type CanaryIndexedSealData = ReturnType<
  typeof captureOriginalCanaryIndexedSealData
>;
