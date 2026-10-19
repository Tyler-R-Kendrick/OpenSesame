/** Initiating-page lifetime and encrypted delivery. Returned bytes still require SAML verification. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  SAML_POST_BYTES,
  type SamlPostChannel,
  SamlPostChannelSchema,
  type SamlPostKeys,
  type SamlPostOwner,
  type SamlPostRecord,
  assertSamlPostOwner,
  samlPostBinding,
  samlPostBytes,
  samlPostChannel,
  samlPostController,
  samlPostDecode,
  samlPostKeys,
  samlPostMac,
  samlPostRpc,
} from "./post-wire.js";
export type SamlPostReceiverOptions = Readonly<{
  scopeUrl: string;
  acsUrl: string;
  requestId: string;
  expiresAt: number;
  idpOrigin: string;
  owner: SamlPostOwner;
}>;
export type SamlUnverifiedPost = Readonly<{
  response: string;
  nonce: string;
  requestId: string;
  acsUrl: string;
}>;
export type SamlPostReceiver = Readonly<{
  nonce: string;
  result: Promise<SamlUnverifiedPost>;
  close: () => void;
}>;
type Claimed = Readonly<{
  record: SamlPostRecord;
  peer: string;
  keys: SamlPostKeys;
}>;
function xmlResponse(response: string): string {
  if (
    !response ||
    response.length > Math.ceil(SAML_POST_BYTES / 3) * 4 ||
    response.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(response)
  )
    throw new Error("Invalid SAML response encoding");
  const binary = atob(response);
  if (binary.length > SAML_POST_BYTES || btoa(binary) !== response)
    throw new Error("Invalid SAML response encoding");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}
class PostReceiver {
  readonly nonce = samlPostBytes(
    crypto.getRandomValues(new Uint8Array(32)).buffer,
  );
  readonly channel = samlPostChannel(this.nonce);
  readonly stop = new AbortController();
  readonly owner: SamlPostOwner;
  readonly result: Promise<SamlUnverifiedPost>;
  active = true;
  claiming = false;
  receiving = false;
  claimed: Claimed | null = null;
  rejectResult: (error: Error) => void = () => undefined;
  resolveResult: (value: SamlUnverifiedPost) => void = () => undefined;
  constructor(
    readonly options: SamlPostReceiverOptions,
    readonly worker: ServiceWorker,
    public keyPair: CryptoKeyPair | null,
    readonly publicKey: string,
  ) {
    this.owner = {
      signal: AbortSignal.any([
        this.stop.signal,
        options.owner.signal,
        AbortSignal.timeout(Math.max(0, options.expiresAt - Date.now())),
      ]),
      assertCurrent: () => {
        options.owner.assertCurrent();
        if (navigator.serviceWorker.controller !== worker)
          throw new Error("SAML service worker changed");
      },
    };
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => undefined); // Consent can open before the coordinator starts awaiting the result.
    this.channel.onmessage = (event: MessageEvent<BoundaryValue>) => {
      const parsed = SamlPostChannelSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.nonce !== this.nonce || !this.active)
        return;
      const value = parsed.data;
      if (value.kind === "hello")
        void this.hello(value.recordId, value.publicKey);
      if (value.kind === "payload") void this.payload(value);
    };
    this.owner.signal.addEventListener("abort", this.close, { once: true });
    window.addEventListener("pagehide", this.close, { once: true });
  }
  close = (): void => {
    if (!this.active) return;
    this.active = false;
    this.claimed = null;
    this.keyPair = null;
    this.owner.signal.removeEventListener("abort", this.close);
    window.removeEventListener("pagehide", this.close);
    this.channel.close();
    this.stop.abort();
    this.rejectResult(
      new Error("SAML originating request is no longer available"),
    );
    // Cancellation is authenticated by the worker's actual event.source, never a caller-supplied owner ID.
    try {
      this.worker.postMessage({ kind: "SAML_CANCEL", nonce: this.nonce });
    } catch {
      /* A stopped worker already discarded volatile custody. */
    }
  };
  current(): void {
    assertSamlPostOwner(this.owner);
    if (!this.active) throw new Error("SAML request already consumed");
  }
  assertRecord(record: SamlPostRecord, recordId: string): void {
    if (
      record.recordId !== recordId ||
      record.nonce !== this.nonce ||
      record.requestId !== this.options.requestId ||
      record.acsUrl !== this.options.acsUrl ||
      record.publicKey !== this.publicKey ||
      record.expiresAt > this.options.expiresAt ||
      record.expiresAt <= Date.now()
    )
      throw new Error("SAML callback does not match the originating request");
  }
  async arm(): Promise<SamlPostReceiver> {
    const armed = await samlPostRpc(
      this.worker,
      {
        kind: "SAML_ARM",
        nonce: this.nonce,
        requestId: this.options.requestId,
        expiresAt: this.options.expiresAt,
        idpOrigin: this.options.idpOrigin,
        publicKey: this.publicKey,
      },
      this.owner,
    );
    this.current();
    if (!armed.ok)
      throw new Error("SAML service worker could not retain this request");
    return Object.freeze({
      nonce: this.nonce,
      result: this.result,
      close: this.close,
    });
  }
  async hello(recordId: string, peer: string): Promise<void> {
    if (this.claiming || this.claimed || !this.keyPair) return;
    this.claiming = true;
    try {
      this.current();
      const approval = await samlPostRpc(
        this.worker,
        { kind: "SAML_CLAIM", recordId, nonce: this.nonce },
        this.owner,
      );
      this.current();
      if (!approval.ok || !approval.record) {
        this.claiming = false;
        return;
      }
      this.assertRecord(approval.record, recordId);
      const pair = this.keyPair;
      if (!pair) throw new Error("SAML request cancelled");
      const keys = await samlPostKeys(
        pair.privateKey,
        peer,
        approval.record,
        this.owner,
      );
      this.current();
      const mac = await samlPostMac(keys.receipt, "ready", this.owner);
      this.current();
      this.claimed = { record: approval.record, peer, keys };
      this.channel.postMessage({
        kind: "ready",
        nonce: this.nonce,
        recordId,
        mac,
      });
    } catch {
      this.close();
    }
  }
  async payload(
    value: Extract<SamlPostChannel, { kind: "payload" }>,
  ): Promise<void> {
    const custody = this.claimed;
    if (
      !custody ||
      this.receiving ||
      value.recordId !== custody.record.recordId ||
      value.publicKey !== custody.peer
    )
      return;
    this.receiving = true; // Atomic one-use claim before cryptographic work.
    try {
      this.current();
      if (custody.record.expiresAt <= Date.now())
        throw new Error("SAML callback expired");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: samlPostDecode(value.iv),
          additionalData: samlPostBinding(custody.record),
        },
        custody.keys.aes,
        samlPostDecode(value.ciphertext),
      );
      this.current();
      if (plaintext.byteLength > SAML_POST_BYTES * 2)
        throw new Error("SAML callback byte limit");
      const xml = xmlResponse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      );
      const mac = await samlPostMac(
        custody.keys.receipt,
        `received:${value.ciphertext}`,
        this.owner,
      );
      this.current();
      if (custody.record.expiresAt <= Date.now())
        throw new Error("SAML callback expired");
      this.channel.postMessage({
        kind: "received",
        nonce: this.nonce,
        recordId: value.recordId,
        mac,
      });
      this.resolveResult(
        Object.freeze({
          response: xml,
          nonce: this.nonce,
          requestId: this.options.requestId,
          acsUrl: this.options.acsUrl,
        }),
      );
      this.close();
    } catch {
      this.close();
    }
  }
}
export async function prepareSamlPostReceiver(
  options: SamlPostReceiverOptions,
): Promise<SamlPostReceiver> {
  const captured = Object.freeze({
    ...options,
    owner: Object.freeze({
      signal: options.owner.signal,
      assertCurrent: options.owner.assertCurrent,
    }),
  });
  const remaining = captured.expiresAt - Date.now();
  if (
    !Number.isInteger(captured.expiresAt) ||
    remaining <= 0 ||
    remaining > 300000
  )
    throw new Error("Invalid SAML request lifetime");
  assertSamlPostOwner(captured.owner);
  const worker = await samlPostController(
    captured.scopeUrl,
    captured.acsUrl,
    captured.owner,
  );
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  assertSamlPostOwner(captured.owner);
  const publicKey = samlPostBytes(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  assertSamlPostOwner(captured.owner);
  if (captured.expiresAt <= Date.now())
    throw new Error("SAML request expired during preparation");
  const receiver = new PostReceiver(captured, worker, pair, publicKey);
  try {
    return await receiver.arm();
  } catch (error) {
    receiver.close();
    throw error;
  }
}
