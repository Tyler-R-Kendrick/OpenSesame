import { subscribeDeviceRows } from "../device-connector-records.js";
import type { HostedModelRuntime } from "../hosted-inference.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
} from "../native-connector-store.js";
import { requireNativeKey } from "../native-key-state.js";
import { assertVaultCredentials } from "../vault-credential-custody.js";
import { capturedAiCredentials, resolvedAiConnection } from "./credentials.js";
import { AI_CONNECTION_CLASSIFICATION, aiConnectionRecord } from "./store.js";
import { captureAiConnectionTransport } from "./transport.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";
import { aiVaultSeams } from "./vault-guard.js";

type ImageCaller = Pick<HostedModelRuntime, "signal" | "assertCurrent">;
function stale(): never {
  throw new AiConnectionError(
    "stale",
    "The generated image's original connection ended.",
  );
}
function imageRowGuard(
  record: NativeConnectorRecord,
  caller: ImageCaller,
  port: AiConnectionTransport,
  signal: AbortSignal,
) {
  const callerSignal = caller.signal;
  const callerCheck = caller.assertCurrent;
  return () => {
    signal.throwIfAborted();
    if (caller.signal !== callerSignal || caller.assertCurrent !== callerCheck)
      stale();
    callerCheck.call(caller);
    port.assertCurrent();
    const current = loadNativeConnectorRecord(record.connectionId);
    if (
      !current ||
      current.revision !== record.revision ||
      current.configuration.fingerprint !== record.configuration.fingerprint
    )
      stale();
  };
}
/** Capture the original row and route synchronously, before any custody await. */
export async function captureImageOwnerContext(
  id: string,
  caller: ImageCaller,
) {
  const port = captureAiConnectionTransport();
  const record = aiConnectionRecord(id);
  if (!record?.privateState.verification) stale();
  requireNativeKey(
    {
      family: "AI",
      accepts: (provider) => provider === record.configuration.providerId,
      classification: AI_CONNECTION_CLASSIFICATION,
    },
    id,
    true,
  );
  const callerSignal = caller.signal;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([port.signal, callerSignal, lifetime.signal]);
  let closed = false;
  let custodyCheck = () => {};
  const rowCheck = imageRowGuard(record, caller, port, signal);
  const check = () => {
    rowCheck();
    custodyCheck();
    rowCheck();
  };
  const withdraw = () => {
    lifetime.abort();
  };
  const observe = () => {
    try {
      check();
    } catch {
      withdraw();
    }
  };
  const rowRelease = subscribeDeviceRows(observe);
  // Route/capability replacements can revoke assertCurrent without emitting a signal.
  const timer = setInterval(observe, 100);
  let vaultRelease = () => {};
  let guard: Awaited<ReturnType<typeof aiVaultSeams.capture>> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    withdraw();
    clearInterval(timer);
    rowRelease();
    vaultRelease();
    guard?.close();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    check();
    guard = await aiVaultSeams.capture();
    if (closed) guard.close();
    check();
    guard.check();
    const heldGuard = guard;
    const custody = await capturedAiCredentials(record, heldGuard.tomb);
    check();
    const draft = await resolvedAiConnection(record, heldGuard.tomb);
    check();
    custodyCheck = () =>
      assertVaultCredentials(custody, heldGuard.tomb, () => heldGuard.check());
    const { vaultStore } = await import("../vault/store.js");
    check();
    vaultRelease = vaultStore.subscribe(observe);
    // This independent guard lives until the view releases it, not HTTP completion.
    const ownerSignal = AbortSignal.any([signal, heldGuard.signal]);
    ownerSignal.addEventListener("abort", close, { once: true });
    check();
    return { draft, port, signal: ownerSignal, check, close };
  } catch (error) {
    close();
    throw error;
  }
}
