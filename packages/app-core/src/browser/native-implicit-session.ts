/** Only the initiating tab holds the nonextractable key that can read returned bearer material. */
import { nativeAuthCallbackUrl } from "./native-auth-message.js";
import {
  type NativeImplicitEnvelope,
  type NativeImplicitPayload,
  type NativeImplicitToken,
  createNativeImplicitKey,
  decryptNativeImplicitPayload,
  encodeImplicitBytes,
  encryptNativeImplicitDelivery,
  nativeImplicitSecretReceipt,
  parseNativeImplicitState,
} from "./native-implicit-crypto.js";
export class NativeImplicitDeniedError extends Error {
  constructor() {
    super("Provider authorization was declined");
    this.name = "NativeImplicitDeniedError";
  }
}
type Provider = "discord" | "reddit" | "google";
type Acknowledgement = { kind: "accepted"; receipt: string };
export type NativeImplicitWait = {
  expiresAt: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  retain: (payload: NativeImplicitToken) => Promise<void>;
};
export type NativeImplicitReceiver = {
  state: string;
  wait: (options: NativeImplicitWait) => Promise<NativeImplicitToken>;
  close: () => void;
};
async function channelName(state: string): Promise<string> {
  parseNativeImplicitState(state);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state),
  );
  return `opensesame.implicit.${encodeImplicitBytes(digest)}`;
}
function cancellation(signal: AbortSignal, isRetaining: () => boolean) {
  let cancel: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      if (!isRetaining())
        reject(new Error("Authorization was cancelled or expired"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  return { promise, remove: () => signal.removeEventListener("abort", cancel) };
}
function assertReceiverCurrent(
  assertCurrent: (() => void) | undefined,
  close: () => void,
): void {
  try {
    assertCurrent?.();
  } catch (error) {
    close();
    throw error;
  }
}
export async function createNativeImplicitReceiver(request: {
  providerId: Provider;
  redirectUri: string;
  nonce: string;
}): Promise<NativeImplicitReceiver> {
  const redirectUri = nativeAuthCallbackUrl(request.redirectUri);
  let generated: Awaited<ReturnType<typeof createNativeImplicitKey>> | null =
    await createNativeImplicitKey(request.providerId, request.nonce);
  const state = generated.state;
  let keys: CryptoKeyPair | null = generated.keys;
  generated = null;
  const channel = new BroadcastChannel(await channelName(state));
  const stopped = new AbortController();
  let claimed = false;
  let waiting = false;
  let retaining = false;
  let retain: NativeImplicitWait["retain"] | null = null;
  let rejectReceived: (error: Error) => void = () => undefined;
  let resolveReceived: (value: NativeImplicitPayload) => void = () => undefined;
  const received = new Promise<NativeImplicitPayload>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });
  channel.onmessage = async (event: MessageEvent<NativeImplicitEnvelope>) => {
    if (!keys || claimed || !retain) return;
    try {
      const currentKeys = keys;
      const payload = await decryptNativeImplicitPayload(
        currentKeys,
        state,
        request.providerId,
        redirectUri,
        event.data,
      );
      if (claimed || stopped.signal.aborted) return;
      const proof = await nativeImplicitSecretReceipt(
        currentKeys.privateKey,
        event.data.publicKey,
        state,
        request.providerId,
        redirectUri,
        event.data,
      );
      if (claimed || stopped.signal.aborted) return;
      claimed = true;
      if (!("error" in payload)) {
        retaining = true;
        await retain(payload);
      }
      channel.postMessage({
        kind: "accepted",
        receipt: proof,
      });
      resolveReceived(payload);
    } catch {
      if (claimed)
        rejectReceived(new Error("Returned credentials could not be retained"));
      /* Untrusted peers cannot consume the receiver with malformed ciphertext. */
    }
  };
  const close = () => {
    keys = null;
    stopped.abort();
    channel.close();
  };
  return {
    state,
    close,
    wait: async (options) => {
      if (waiting || stopped.signal.aborted)
        throw new Error("Authorization receiver is no longer available");
      waiting = true;
      retain = options.retain;
      assertReceiverCurrent(options.assertCurrent, close);
      const remaining = options.expiresAt - Date.now();
      if (remaining <= 0 || remaining > 600_000) {
        close();
        throw new Error("Authorization expired");
      }
      const signal = AbortSignal.any([
        stopped.signal,
        AbortSignal.timeout(remaining),
        ...(options.signal ? [options.signal] : []),
      ]);
      const cancelled = cancellation(signal, () => retaining);
      try {
        const payload = await Promise.race([received, cancelled.promise]);
        if ("error" in payload) throw new NativeImplicitDeniedError();
        return payload;
      } finally {
        cancelled.remove();
        close();
      }
    },
  };
}
/** Ciphertext is the only token-bearing data placed on a BroadcastChannel. */
export async function deliverNativeImplicitPayload(
  state: string,
  providerId: Provider,
  redirectUri: string,
  payload: NativeImplicitPayload,
): Promise<void> {
  const approvedRedirect = nativeAuthCallbackUrl(redirectUri);
  const delivery = await encryptNativeImplicitDelivery(
    state,
    providerId,
    approvedRedirect,
    payload,
  );
  const expected = delivery.receipt;
  const channel = new BroadcastChannel(await channelName(state));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error("The originating connection window is unavailable")),
        15_000,
      );
      channel.onmessage = (event: MessageEvent<Acknowledgement>) => {
        if (event.data?.kind !== "accepted" || event.data.receipt !== expected)
          return;
        clearTimeout(timeout);
        resolve();
      };
      channel.postMessage(delivery.envelope);
    });
  } finally {
    channel.close();
  }
}
