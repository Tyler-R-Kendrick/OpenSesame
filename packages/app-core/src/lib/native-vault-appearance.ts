/** Verified Vault bindings keep their authority when only their display preferences change. */
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import {
  NativeConfigurationSchema,
  type NativeFieldClassification,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export interface NativeVaultAppearance {
  displayName?: string;
  icon?: string;
}
export function nativeVaultAppearance(
  input: NativeVaultAppearance,
  defaults: { displayName: string; icon: string },
  secrets: Record<string, string> = {},
) {
  const value = NativeConfigurationSchema.pick({
    displayName: true,
    icon: true,
  }).safeParse({
    displayName:
      input.displayName === undefined
        ? defaults.displayName
        : input.displayName.trim(),
    icon: input.icon ?? defaults.icon,
  });
  if (!value.success)
    throw new Error("Enter a valid connection name and PNG or JPEG icon");
  safeProviderText(value.data.displayName, secrets);
  safeNativeConnectorIcon(value.data.icon, secrets);
  return value.data;
}
export async function updateNativeVaultAppearance(
  record: NativeConnectorRecord,
  input: NativeVaultAppearance,
  transport: NativeProviderTransport,
  classification: NativeFieldClassification,
) {
  const appearance = nativeVaultAppearance(
    input,
    record.configuration,
    record.privateState.credentials,
  );
  if (
    appearance.displayName === record.configuration.displayName &&
    appearance.icon === record.configuration.icon
  )
    return record.connectionId;
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new Error(
      "Finish provider authorization cleanup before editing this connection",
    );
  await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    classification,
    (current) => {
      transport.assertCurrent();
      current.configuration = { ...current.configuration, ...appearance };
      return current;
    },
    () => transport.assertCurrent(),
  );
  return record.connectionId;
}
