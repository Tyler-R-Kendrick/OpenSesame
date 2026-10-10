/** Fixed original P-256 operations only; no Root, owner permission or lock grant. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type DeviceIdentityKeyRecord,
  type DeviceKeyTimeBounds,
  bytesToB64,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const NAMES = [
  "generateKey",
  "exportKey",
  "importKey",
  "digest",
  "sign",
  "verify",
] as const;
const CHALLENGE = new TextEncoder().encode("opensesame device identity key");

function fixedCryptoMethods(
  subtle: SubtleCrypto,
  methods: Pick<SubtleCrypto, (typeof NAMES)[number]>,
) {
  return {
    fixedGenerate: methods.generateKey.bind(subtle),
    fixedExport: methods.exportKey.bind(subtle),
    fixedImport: methods.importKey.bind(subtle),
    fixedDigest: methods.digest.bind(subtle),
    fixedSign: methods.sign.bind(subtle),
    fixedVerify: methods.verify.bind(subtle),
  };
}
class OriginalDeviceIdentityCryptoData {
  readonly #original: () => void;
  readonly #installed: Crypto;
  readonly #subtle: SubtleCrypto;
  readonly #methods: Pick<SubtleCrypto, (typeof NAMES)[number]>;
  readonly #fixed: ReturnType<typeof fixedCryptoMethods>;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #calls = new Set<Promise<unknown>>();
  #live = true;
  constructor(original: () => void) {
    original();
    this.#original = original;
    this.#installed = crypto;
    this.#subtle = this.#installed.subtle;
    const { generateKey, exportKey, importKey, digest, sign, verify } =
      this.#subtle;
    this.#methods = { generateKey, exportKey, importKey, digest, sign, verify };
    this.#check();
    this.#fixed = fixedCryptoMethods(this.#subtle, this.#methods);
    Object.freeze(this);
  }
  #check = () => {
    this.#original();
    if (
      !this.#live ||
      crypto !== this.#installed ||
      this.#installed.subtle !== this.#subtle
    )
      throw new Error("Original identity crypto retired.");
    for (const name of NAMES) {
      if (
        typeof this.#methods[name] !== "function" ||
        this.#subtle[name] !== this.#methods[name]
      )
        throw new Error("Original identity crypto method changed.");
    }
  };
  #accept = <T>(work: () => Promise<T>): Promise<T> => {
    const task = Promise.resolve().then(async () => {
      this.#check();
      const value = await work();
      this.#check();
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
  #thumbprintWork = async (jwk: Readonly<{ x: string; y: string }>) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }),
    );
    const hash = await this.#accept(() =>
      this.#fixed.fixedDigest("SHA-256", bytes),
    );
    return bytesToB64(new Uint8Array(hash))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  };
  #trustedWork = async (
    input: BoundaryValue,
    bounds: Partial<DeviceKeyTimeBounds> = {},
  ): Promise<DeviceIdentityKeyRecord | null> => {
    this.#check();
    const parsed = readDeviceIdentityKeyRecord(
      input,
      bounds.now ?? Date.now(),
      bounds.notBefore ?? 1,
    );
    if (!parsed) return null;
    const record = structuredClone(parsed);
    if (record.keyId !== (await this.#thumbprintWork(record.publicJwk)))
      return null;
    let privateJwk: BoundaryValue;
    try {
      privateJwk = JSON.parse(record.privateJwkJson);
    } catch {
      return null;
    }
    if (
      !isJsonObject(privateJwk) ||
      privateJwk.kty !== "EC" ||
      privateJwk.crv !== "P-256" ||
      !isString(privateJwk.d) ||
      privateJwk.x !== record.publicJwk.x ||
      privateJwk.y !== record.publicJwk.y
    )
      return null;
    const owned = {
      kty: "EC",
      crv: "P-256",
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d,
    };
    try {
      const priv = await this.#accept(() =>
        this.#fixed.fixedImport("jwk", owned, ECDSA, false, ["sign"]),
      );
      const pub = await this.#accept(() =>
        this.#fixed.fixedImport("jwk", { ...record.publicJwk }, ECDSA, false, [
          "verify",
        ]),
      );
      const signature = await this.#accept(() =>
        this.#fixed.fixedSign(SIGN, priv, CHALLENGE),
      );
      const valid = await this.#accept(() =>
        this.#fixed.fixedVerify(SIGN, pub, signature, CHALLENGE),
      );
      this.#check();
      return valid ? record : null;
    } catch {
      this.#check();
      return null;
    }
  };
  #mintWork = async (): Promise<DeviceIdentityKeyRecord> => {
    const pair = await this.#accept(() =>
      this.#fixed.fixedGenerate(ECDSA, true, ["sign", "verify"]),
    );
    const pub = await this.#accept(() =>
      this.#fixed.fixedExport("jwk", pair.publicKey),
    );
    const priv = await this.#accept(() =>
      this.#fixed.fixedExport("jwk", pair.privateKey),
    );
    if (!isString(pub.x) || !isString(pub.y) || !isString(priv.d))
      throw new Error("Original identity generated an unreadable key.");
    const publicJwk = { kty: "EC", crv: "P-256", x: pub.x, y: pub.y } as const;
    const keyId = await this.#thumbprintWork(publicJwk);
    this.#check();
    return {
      version: 1,
      keyId,
      publicJwk,
      privateJwkJson: JSON.stringify({ ...publicJwk, d: priv.d, alg: "ES256" }),
      createdAt: Date.now(),
    };
  };
  port() {
    return Object.freeze({
      check: this.#check,
      trusted: (
        input: BoundaryValue,
        bounds: Partial<DeviceKeyTimeBounds> = {},
      ) => this.#track(() => this.#trustedWork(input, bounds)),
      mint: () => this.#track(this.#mintWork),
      thumbprint: (jwk: Readonly<{ x: string; y: string }>) =>
        this.#track(() => this.#thumbprintWork(jwk)),
      identities: Object.freeze([
        this.#installed,
        this.#subtle,
        ...Object.values(this.#methods),
      ]),
      close: async () => {
        this.#live = false;
        const accepted = [...new Set([...this.#calls, ...this.#pending])];
        const results = await Promise.allSettled(accepted);
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length)
          throw new AggregateError(
            errors,
            "Original identity crypto refused after accepted work drain.",
          );
      },
    });
  }
}
/** Captured before the private Store queues its actual original identity work. */
export function captureOriginalDeviceIdentityCryptoData(original: () => void) {
  return new OriginalDeviceIdentityCryptoData(original).port();
}
