/**
 * AWS Secrets Manager and Parameter Store from a browser (ADR 0197): the
 * person's own access key, signed with Signature Version 4, sent to the
 * endpoint AWS publishes for the region. Verification is a real list call, so
 * it proves the key may list names and nothing about who owns the account.
 */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  NATIVE_AWS_SERVICES,
  type NativeAwsTarget,
  nativeAwsClassification,
  nativeAwsFingerprint,
  nativeAwsInput,
  nativeAwsProviderOf,
} from "./native-aws-input.js";
import {
  readNativeAwsNames,
  readNativeAwsValue,
} from "./native-aws-operations.js";
import {
  invalidateNativeAws,
  nativeAwsCredentialBinding,
  requireNativeAws,
  verifiedNativeAws,
} from "./native-aws-state.js";
import {
  assertNativeConnectorRevision,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export { nativeAwsCleanup } from "./native-aws-state.js";
export { isNativeAwsProvider } from "./native-aws-input.js";

export type NativeAwsResult = {
  label: string;
  items: { id: string; label: string; secretValue?: string }[];
};

type Saved = ReturnType<typeof requireNativeAws>;

function targetOf(saved: Saved): NativeAwsTarget {
  return {
    providerId: nativeAwsProviderOf(saved.configuration.providerId),
    parameters: saved.configuration.parameters,
    credentials: saved.privateState.credentials,
  };
}

/** A key AWS refused, or a permission it withdrew, ends the proof the connection carried. */
function refusedKey(error: NativeApiError): boolean {
  return ["authorization", "permission"].includes(error.code);
}

/** The first page of names, read with a saved connection that is still the one that was verified. */
async function savedNames(
  id: string,
  transport: NativeProviderTransport,
  authorized = false,
) {
  const saved = requireNativeAws(id, authorized);
  await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
  try {
    if (
      saved.configuration.fingerprint !==
      (await nativeAwsFingerprint(
        nativeAwsProviderOf(saved.configuration.providerId),
        saved.configuration.parameters,
      ))
    )
      throw new Error("AWS binding changed; configure again");
    const items = await readNativeAwsNames(targetOf(saved), transport);
    await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
    return { saved, items };
  } catch (error) {
    if (error instanceof NativeApiError && refusedKey(error))
      await invalidateNativeAws(saved, transport);
    throw error;
  }
}

/** Where a save may start: the saved connection is the one that was read, and for this service. */
function assertSaveable(
  saved: Saved | null,
  input: NativeApiConfigureInput,
): void {
  if (saved && saved.revision !== input.revision)
    throw new Error("AWS connection changed; reload before saving");
  if (saved && saved.configuration.providerId !== input.providerId)
    throw new Error("Saved connection belongs to another AWS service");
  if (!input.displayName.trim() || input.displayName.trim().length > 256)
    throw new Error("Enter a valid AWS connection name");
}

/** A real list call proves the key; a refused key must not leave the saved one looking verified. */
async function proveKey(
  target: NativeAwsTarget,
  saved: Saved | null,
  fingerprint: string,
  transport: NativeProviderTransport,
) {
  try {
    await readNativeAwsNames(target, transport);
  } catch (error) {
    if (
      error instanceof NativeApiError &&
      refusedKey(error) &&
      saved &&
      saved.configuration.fingerprint === fingerprint &&
      nativeAwsCredentialBinding(saved.privateState.credentials) ===
        nativeAwsCredentialBinding(target.credentials)
    )
      await invalidateNativeAws(saved, transport);
    throw error;
  }
}

export async function configureNativeAws(
  input: NativeApiConfigureInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  const saved = input.connectionId
    ? requireNativeAws(input.connectionId)
    : null;
  assertSaveable(saved, input);
  const target = nativeAwsInput(input, saved);
  if (saved)
    await assertNativeConnectorRevision(
      saved.connectionId,
      nativeOAuthGuard(saved),
    );
  const fingerprint = await nativeAwsFingerprint(
    target.providerId,
    target.parameters,
  );
  await proveKey(target, saved, fingerprint, transport);
  transport.assertCurrent();
  const id = saved?.connectionId ?? `conn_aws_${crypto.randomUUID()}`;
  const next = verifiedNativeAws(
    id,
    saved?.revision ?? 1,
    {
      version: 1,
      providerId: target.providerId,
      method: "api-key",
      displayName: input.displayName.trim(),
      icon: input.icon ?? "",
      parameters: target.parameters,
      requestedScopes: {},
      targetIds: { region: target.parameters.region ?? "" },
      fingerprint,
    },
    target.credentials,
    saved?.runtime.verifiedAt ?? 0,
  );
  if (!saved)
    return saveNativeConnector(next, nativeAwsClassification, () =>
      transport.assertCurrent(),
    );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    nativeAwsClassification,
    () => {
      transport.assertCurrent();
      return next;
    },
    () => transport.assertCurrent(),
  );
}

export async function verifyNativeAws(
  id: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const { saved } = await savedNames(id, transport);
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    nativeAwsClassification,
    () => {
      transport.assertCurrent();
      return verifiedNativeAws(
        id,
        saved.revision,
        saved.configuration,
        saved.privateState.credentials,
        saved.runtime.verifiedAt ?? 0,
      );
    },
    () => transport.assertCurrent(),
  );
}

const OPERATIONS = [
  "provider.read",
  "provider.names.read",
  "provider.secret.read",
];

/** Which operation, with which input: nothing a person was not offered. */
function assertOffered(operation: string, input: Record<string, string>) {
  const keys = Object.keys(input);
  const exact =
    operation === "provider.secret.read"
      ? keys.length === 1 && keys[0] === "name"
      : keys.length === 0;
  if (!OPERATIONS.includes(operation) || !exact)
    throw new Error("Select a supported AWS operation");
}

/** One value, on request, from a connection that is still the one that was verified. */
async function readValueOnRequest(
  id: string,
  name: string,
  transport: NativeProviderTransport,
): Promise<NativeAwsResult> {
  const saved = requireNativeAws(id, true);
  await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
  try {
    const secretValue = await readNativeAwsValue(
      targetOf(saved),
      transport,
      name,
    );
    await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
    return {
      label: "Value read once",
      items: [{ id: name, label: name, secretValue }],
    };
  } catch (error) {
    if (error instanceof NativeApiError && refusedKey(error))
      await invalidateNativeAws(saved, transport);
    throw error;
  }
}

export async function invokeNativeAws(
  id: string,
  operation: string,
  input: Record<string, string> = {},
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeAwsResult> {
  assertOffered(operation, input);
  if (operation === "provider.secret.read")
    return readValueOnRequest(id, input.name ?? "", transport);
  const { saved, items } = await savedNames(id, transport, true);
  const service =
    NATIVE_AWS_SERVICES[nativeAwsProviderOf(saved.configuration.providerId)];
  return {
    label:
      operation === "provider.read"
        ? `${service.name} access verified`
        : `First ${items.length} names`,
    items: operation === "provider.read" ? [] : items,
  };
}
