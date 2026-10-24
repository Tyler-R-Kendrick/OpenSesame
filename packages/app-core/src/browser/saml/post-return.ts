/** The ACS document consumes only its actual service-worker client record. */
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  SAML_POST_BYTES,
  type SamlPostChannel,
  SamlPostChannelSchema,
  type SamlPostKeys,
  type SamlPostOwner,
  type SamlPostRecord,
  assertSamlPostOwner,
  checkSamlPostMac,
  samlPostBinding,
  samlPostBytes,
  samlPostChannel,
  samlPostController,
  samlPostKeys,
  samlPostRpc,
} from "./post-wire.js";
export type SamlPostReturnOptions = Readonly<{
  scopeUrl: string;
  acsUrl: string;
  owner: SamlPostOwner;
}>;
type SenderKeys = Readonly<{ publicKey: string; keys: SamlPostKeys }>;
function receive(
  channel: BroadcastChannel,
  kind: "ready" | "received",
  record: SamlPostRecord,
  owner: SamlPostOwner,
): Promise<SamlPostChannel> {
  assertSamlPostOwner(owner);
  return new Promise((resolve, reject) => {
    const end = (value: SamlPostChannel | Error) => {
      clearTimeout(timer);
      channel.removeEventListener("message", listener);
      owner.signal.removeEventListener("abort", cancel);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const cancel = () => end(new Error("SAML callback cancelled"));
    const listener = (event: MessageEvent<BoundaryValue>) => {
      const parsed = SamlPostChannelSchema.safeParse(event.data);
      if (
        !parsed.success ||
        parsed.data.kind !== kind ||
        parsed.data.nonce !== record.nonce ||
        parsed.data.recordId !== record.recordId
      )
        return;
      try {
        assertSamlPostOwner(owner);
        end(parsed.data);
      } catch {
        cancel();
      }
    };
    const timer = setTimeout(
      () => end(new Error("The originating SAML window is unavailable")),
      5000,
    );
    channel.addEventListener("message", listener);
    owner.signal.addEventListener("abort", cancel, { once: true });
  });
}
async function readyKeys(
  channel: BroadcastChannel,
  record: SamlPostRecord,
  owner: SamlPostOwner,
): Promise<SenderKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  assertSamlPostOwner(owner);
  const publicKey = samlPostBytes(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  assertSamlPostOwner(owner);
  const keys = await samlPostKeys(
    pair.privateKey,
    record.publicKey,
    record,
    owner,
  );
  const ready = receive(channel, "ready", record, owner);
  channel.postMessage({
    kind: "hello",
    nonce: record.nonce,
    recordId: record.recordId,
    publicKey,
  });
  const message = await ready;
  if (
    message.kind !== "ready" ||
    !(await checkSamlPostMac(keys.receipt, message.mac, "ready", owner))
  )
    throw new Error("SAML callback has no authentic originating receiver");
  assertSamlPostOwner(owner);
  return { publicKey, keys };
}
async function deliver(
  channel: BroadcastChannel,
  worker: ServiceWorker,
  record: SamlPostRecord,
  sender: SenderKeys,
  owner: SamlPostOwner,
): Promise<void> {
  const consumed = await samlPostRpc(
    worker,
    { kind: "SAML_CONSUME", nonce: record.nonce, recordId: record.recordId },
    owner,
  );
  assertSamlPostOwner(owner);
  if (
    !consumed.ok ||
    !consumed.record ||
    consumed.response === undefined ||
    JSON.stringify(consumed.record) !== JSON.stringify(record) ||
    consumed.response.length > SAML_POST_BYTES * 2 ||
    record.expiresAt <= Date.now()
  )
    throw new Error("SAML callback is no longer available");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = samlPostBytes(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: samlPostBinding(record) },
      sender.keys.aes,
      new TextEncoder().encode(consumed.response),
    ),
  );
  assertSamlPostOwner(owner);
  const acknowledgement = receive(channel, "received", record, owner);
  channel.postMessage({
    kind: "payload",
    nonce: record.nonce,
    recordId: record.recordId,
    publicKey: sender.publicKey,
    iv: samlPostBytes(iv.buffer),
    ciphertext,
  });
  const ack = await acknowledgement;
  if (
    ack.kind !== "received" ||
    !(await checkSamlPostMac(
      sender.keys.receipt,
      ack.mac,
      `received:${ciphertext}`,
      owner,
    ))
  )
    throw new Error("SAML callback delivery was not acknowledged");
  assertSamlPostOwner(owner);
}
/** Receipt confirms encrypted delivery only; signature validation and identity admission remain separate. */
export async function returnSamlPost(
  options: SamlPostReturnOptions,
): Promise<void> {
  const captured = Object.freeze({
    ...options,
    owner: Object.freeze({
      signal: options.owner.signal,
      assertCurrent: options.owner.assertCurrent,
    }),
  });
  if (location.href !== captured.acsUrl || window.top !== window)
    throw new Error("SAML callback requires its exact top-level ACS");
  const stop = new AbortController();
  const owner: SamlPostOwner = {
    signal: AbortSignal.any([
      captured.owner.signal,
      stop.signal,
      AbortSignal.timeout(15000),
    ]),
    assertCurrent: () => captured.owner.assertCurrent(),
  };
  const worker = await samlPostController(
    captured.scopeUrl,
    captured.acsUrl,
    owner,
  );
  const controllerOwner: SamlPostOwner = {
    signal: owner.signal,
    assertCurrent() {
      owner.assertCurrent();
      if (navigator.serviceWorker.controller !== worker)
        throw new Error("SAML callback worker changed");
    },
  };
  const metadata = await samlPostRpc(
    worker,
    { kind: "SAML_METADATA" },
    controllerOwner,
  );
  assertSamlPostOwner(controllerOwner);
  if (
    !metadata.ok ||
    !metadata.record ||
    metadata.record.acsUrl !== captured.acsUrl ||
    metadata.record.expiresAt <= Date.now()
  )
    throw new Error("SAML callback custody is missing or expired");
  const record = metadata.record;
  const channel = samlPostChannel(record.nonce);
  try {
    await deliver(
      channel,
      worker,
      record,
      await readyKeys(channel, record, controllerOwner),
      controllerOwner,
    );
  } finally {
    stop.abort();
    channel.close();
  }
}
