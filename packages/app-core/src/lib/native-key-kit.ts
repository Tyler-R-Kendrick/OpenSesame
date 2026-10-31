/**
 * The guards every key-driven family shares (ADR 0198): a saved connection that
 * is still the one that was read and still bound to what it was proved for, a
 * call run against it that cannot leave a refused key looking verified, and the
 * rule that a person is only ever offered what the family lists.
 */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  invalidateNativeKey,
  nativeKeyBinding,
  requireNativeKey,
} from "./native-key-state.js";
import type {
  NativeKeyOperation,
  NativeKeySpec,
  NativeKeyTarget,
} from "./native-key-types.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

/** A key a provider refused, or a permission it withdrew, ends the proof a connection carried. */
function defaultRefused(error: NativeApiError): boolean {
  return ["authorization", "permission"].includes(error.code);
}

export type NativeKeyKit<T extends NativeKeyTarget> = {
  spec: NativeKeySpec<T>;
  refused: (error: NativeApiError) => boolean;
};

export function nativeKeyKit<T extends NativeKeyTarget>(
  spec: NativeKeySpec<T>,
): NativeKeyKit<T> {
  return { spec, refused: spec.refused ?? defaultRefused };
}

/** A saved connection that is still the one that was read, and still bound to what it was proved for. */
async function loadBound<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  id: string,
  authorized: boolean,
) {
  const saved = requireNativeKey(kit.spec, id, authorized);
  await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
  const target = kit.spec.targetOf(saved);
  if (saved.configuration.fingerprint !== (await kit.spec.fingerprint(target)))
    throw new Error(`${kit.spec.family} binding changed; configure again`);
  return { saved, target };
}

/** Run one call against a saved connection; a refused key must not leave it looking verified. */
export async function withSaved<T extends NativeKeyTarget, R>(
  kit: NativeKeyKit<T>,
  id: string,
  authorized: boolean,
  transport: NativeProviderTransport,
  call: (target: T) => Promise<R>,
) {
  transport.assertCurrent();
  const { saved, target } = await loadBound(kit, id, authorized);
  transport.assertCurrent();
  try {
    const value = await call(target);
    // A provider may decrypt locally after its last HTTP response. The
    // original transport still owns the result and the final revision read.
    transport.assertCurrent();
    await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
    transport.assertCurrent();
    return { saved, value };
  } catch (error) {
    if (error instanceof NativeApiError && kit.refused(error))
      await invalidateNativeKey(kit.spec.classification, saved, transport);
    throw error;
  }
}

export function assertSaveable<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  saved: NativeConnectorRecord | null,
  input: NativeApiConfigureInput,
) {
  const { family, accepts } = kit.spec;
  if (!accepts(input.providerId))
    throw new Error(`${input.providerId} is not a ${family} service`);
  if (saved && saved.revision !== input.revision)
    throw new Error(`${family} connection changed; reload before saving`);
  if (saved && saved.configuration.providerId !== input.providerId)
    throw new Error(`Saved connection belongs to another ${family} service`);
  if (!input.displayName.trim() || input.displayName.trim().length > 256)
    throw new Error(`Enter a valid ${family} connection name`);
}

/** The real call proves the key; a refused key must not leave the saved one looking verified. */
export async function proveKey<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  target: T,
  saved: NativeConnectorRecord | null,
  fingerprint: string,
  transport: NativeProviderTransport,
) {
  try {
    return await kit.spec.prove(target, transport);
  } catch (error) {
    const classification = kit.spec.classification;
    if (
      error instanceof NativeApiError &&
      kit.refused(error) &&
      saved &&
      saved.configuration.fingerprint === fingerprint &&
      nativeKeyBinding(classification, saved.privateState.credentials) ===
        nativeKeyBinding(classification, target.credentials)
    )
      await invalidateNativeKey(classification, saved, transport);
    throw error;
  }
}

/** Which operation, with which input: nothing a person was not offered. `null` is the re-proof. */
export function offered<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  operation: string,
  input: Record<string, string>,
): NativeKeyOperation<T> | null {
  const refuse = () =>
    new Error(`Select a supported ${kit.spec.family} operation`);
  if (operation === "provider.read") {
    if (Object.keys(input).length) throw refuse();
    return null;
  }
  const found = kit.spec.operations.find((entry) => entry.id === operation);
  const keys = Object.keys(input);
  if (
    !found ||
    keys.length !== found.inputKeys.length ||
    !found.inputKeys.every((key) => keys.includes(key))
  )
    throw refuse();
  return found;
}
