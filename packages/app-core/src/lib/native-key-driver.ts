/**
 * The flows every key-driven provider shares (ADR 0198): prove the key with a
 * real call before anything is saved, bind a saved connection to exactly what
 * was proved, re-prove on request, read on request, and forget locally. A
 * provider family is only a `NativeKeySpec`; nothing here knows its API.
 */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";
import {
  assertNativeConnectorRevision,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import {
  type NativeKeyKit,
  assertSaveable,
  nativeKeyKit,
  offered,
  proveKey,
  withSaved,
} from "./native-key-kit.js";
import {
  nativeKeyCleanup,
  requireNativeKey,
  verifiedNativeKey,
} from "./native-key-state.js";
import type {
  NativeKeyResult,
  NativeKeySpec,
  NativeKeyTarget,
  NativeKeyUi,
} from "./native-key-types.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export type NativeKeyFlows = {
  family: string;
  accepts: (providerId: string) => boolean;
  ui: (providerId: string) => NativeKeyUi;
  configure: (
    input: NativeApiConfigureInput,
    transport?: NativeProviderTransport,
  ) => ReturnType<typeof saveNativeConnector>;
  verify: (
    id: string,
    transport?: NativeProviderTransport,
  ) => ReturnType<typeof updateNativeConnector>;
  invoke: (
    id: string,
    operation: string,
    input?: Record<string, string>,
    transport?: NativeProviderTransport,
  ) => Promise<NativeKeyResult>;
  cleanup: NativeProviderCleanup;
};

async function configureKey<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  input: NativeApiConfigureInput,
  transport: NativeProviderTransport,
) {
  const { spec } = kit;
  const classification = spec.classification;
  transport.assertCurrent();
  const saved = input.connectionId
    ? requireNativeKey(spec, input.connectionId)
    : null;
  assertSaveable(kit, saved, input);
  const target = await spec.parse(input, saved);
  if (saved)
    await assertNativeConnectorRevision(
      saved.connectionId,
      nativeOAuthGuard(saved),
    );
  const fingerprint = await spec.fingerprint(target);
  const proof = await proveKey(kit, target, saved, fingerprint, transport);
  transport.assertCurrent();
  const id = saved?.connectionId ?? `${spec.idPrefix}${crypto.randomUUID()}`;
  const next = verifiedNativeKey(
    classification,
    id,
    saved?.revision ?? 1,
    {
      version: 1,
      providerId: target.providerId,
      method: "api-key",
      displayName: input.displayName.trim(),
      icon: input.icon ?? "",
      parameters: { ...target.parameters, ...proof.update?.parameters },
      requestedScopes: {},
      targetIds: { [proof.target.key]: proof.target.id },
      fingerprint,
    },
    { ...target.credentials, ...proof.update?.credentials },
    proof,
    saved?.runtime.verifiedAt ?? 0,
  );
  if (!saved)
    return saveNativeConnector(next, classification, () =>
      transport.assertCurrent(),
    );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    classification,
    () => {
      transport.assertCurrent();
      return next;
    },
    () => transport.assertCurrent(),
  );
}

async function verifyKey<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  id: string,
  transport: NativeProviderTransport,
) {
  const classification = kit.spec.classification;
  const { saved, value: proof } = await withSaved(
    kit,
    id,
    false,
    transport,
    (target) => kit.spec.prove(target, transport),
  );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    classification,
    () => {
      transport.assertCurrent();
      return verifiedNativeKey(
        classification,
        id,
        saved.revision,
        {
          ...saved.configuration,
          parameters: {
            ...saved.configuration.parameters,
            ...proof.update?.parameters,
          },
        },
        { ...saved.privateState.credentials, ...proof.update?.credentials },
        proof,
        saved.runtime.verifiedAt ?? 0,
      );
    },
    () => transport.assertCurrent(),
  );
}

async function invokeKey<T extends NativeKeyTarget>(
  kit: NativeKeyKit<T>,
  id: string,
  operation: string,
  input: Record<string, string>,
  transport: NativeProviderTransport,
): Promise<NativeKeyResult> {
  const found = offered(kit, operation, input);
  if (!found) {
    const { saved } = await withSaved(kit, id, true, transport, (target) =>
      kit.spec.prove(target, transport),
    );
    transport.assertCurrent();
    return {
      label: `${kit.spec.ui(saved.configuration.providerId).name} access verified`,
      items: [],
    };
  }
  const { value } = await withSaved(kit, id, true, transport, (target) =>
    found.run(target, transport, input),
  );
  transport.assertCurrent();
  return value;
}

export function createNativeKeyFlows<T extends NativeKeyTarget>(
  spec: NativeKeySpec<T>,
): NativeKeyFlows {
  const kit = nativeKeyKit(spec);
  return {
    family: spec.family,
    accepts: spec.accepts,
    ui: spec.ui,
    configure: (input, transport = nativeProviderTransport()) =>
      configureKey(kit, input, transport),
    verify: (id, transport = nativeProviderTransport()) =>
      verifyKey(kit, id, transport),
    invoke: (
      id,
      operation,
      input = {},
      transport = nativeProviderTransport(),
    ) => invokeKey(kit, id, operation, input, transport),
    cleanup: nativeKeyCleanup(spec),
  };
}
