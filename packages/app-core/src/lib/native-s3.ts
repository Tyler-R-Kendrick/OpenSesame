import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
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
import { readNativeS3Bucket } from "./native-s3-http.js";
import {
  nativeS3Classification,
  nativeS3Fingerprint,
  nativeS3Input,
} from "./native-s3-input.js";
import {
  invalidateNativeS3,
  nativeS3CredentialBinding,
  requireNativeS3,
  verifiedNativeS3,
} from "./native-s3-state.js";

async function configureListing(
  saved: ReturnType<typeof requireNativeS3> | null,
  target: ReturnType<typeof nativeS3Input>,
  fingerprint: string,
  transport: NativeProviderTransport,
) {
  try {
    return await readNativeS3Bucket(target, transport);
  } catch (error) {
    if (
      saved &&
      error instanceof NativeApiError &&
      ["authorization", "permission"].includes(error.code) &&
      saved.configuration.fingerprint === fingerprint &&
      nativeS3CredentialBinding(saved.privateState.credentials) ===
        nativeS3CredentialBinding(target.credentials)
    )
      await invalidateNativeS3(saved, transport);
    throw error;
  }
}

async function savedListing(
  id: string,
  transport: NativeProviderTransport,
  authorized = false,
) {
  const saved = requireNativeS3(id, authorized);
  await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
  try {
    if (
      saved.configuration.fingerprint !==
      (await nativeS3Fingerprint(saved.configuration.parameters))
    )
      throw new Error("S3 binding changed; configure again");
    const items = await readNativeS3Bucket(
      {
        parameters: saved.configuration.parameters,
        credentials: saved.privateState.credentials,
      },
      transport,
    );
    await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
    return { saved, items };
  } catch (error) {
    if (
      error instanceof NativeApiError &&
      ["authorization", "permission"].includes(error.code)
    )
      await invalidateNativeS3(saved, transport);
    throw error;
  }
}
function verifiedRecord(
  id: string,
  saved: ReturnType<typeof requireNativeS3> | null,
  input: NativeApiConfigureInput,
  target: ReturnType<typeof nativeS3Input>,
  fingerprint: string,
) {
  return verifiedNativeS3(
    id,
    saved?.revision ?? 1,
    {
      version: 1,
      providerId: "s3",
      method: "api-key",
      displayName: input.displayName.trim(),
      icon: input.icon ?? "",
      parameters: target.parameters,
      requestedScopes: {},
      targetIds: { bucket: target.parameters.bucket ?? "" },
      fingerprint,
    },
    target.credentials,
    saved?.runtime.verifiedAt ?? 0,
  );
}
export async function configureNativeS3(
  input: NativeApiConfigureInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  const saved = input.connectionId ? requireNativeS3(input.connectionId) : null;
  if (saved && saved.revision !== input.revision)
    throw new Error("S3 connection changed; reload before saving");
  if (!input.displayName.trim() || input.displayName.trim().length > 256)
    throw new Error("Enter a valid S3 connection name");
  const target = nativeS3Input(input, saved);
  if (saved)
    await assertNativeConnectorRevision(
      saved.connectionId,
      nativeOAuthGuard(saved),
    );
  const fingerprint = await nativeS3Fingerprint(target.parameters);
  await configureListing(saved, target, fingerprint, transport);
  transport.assertCurrent();
  const id = saved?.connectionId ?? `conn_s3_${crypto.randomUUID()}`;
  const next = verifiedRecord(id, saved, input, target, fingerprint);
  if (!saved)
    return saveNativeConnector(next, nativeS3Classification, () =>
      transport.assertCurrent(),
    );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    nativeS3Classification,
    () => {
      transport.assertCurrent();
      return next;
    },
    () => transport.assertCurrent(),
  );
}
export async function verifyNativeS3(
  id: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const { saved } = await savedListing(id, transport);
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    nativeS3Classification,
    () => {
      transport.assertCurrent();
      return verifiedNativeS3(
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
export async function invokeNativeS3(
  id: string,
  operation: string,
  input: Record<string, string> = {},
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeApiReadResult> {
  if (
    !["provider.read", "provider.objects.read"].includes(operation) ||
    Object.keys(input).length
  )
    throw new Error("Select a supported S3 bucket operation");
  const { saved, items } = await savedListing(id, transport, true);
  return {
    label:
      operation === "provider.read"
        ? `${saved.configuration.parameters.bucket} list access verified`
        : "First 100 object keys under the configured prefix",
    items: operation === "provider.read" ? [] : items,
  };
}
export { nativeS3Cleanup } from "./native-s3-state.js";
