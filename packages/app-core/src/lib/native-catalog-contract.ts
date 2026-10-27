import type { Provider } from "./connections.js";
import type { NativeFieldClassification } from "./native-connector-schema.js";

export type NativeCatalogConfiguration = {
  provider: Provider;
  classification: NativeFieldClassification;
};

export function nativeCatalogConfigurationContract(
  provider: Provider,
): NativeCatalogConfiguration | null {
  const fields = provider.configurationFields;
  const wallet =
    provider.id === "google-wallet" &&
    provider.authKind === "configuration" &&
    provider.egress.scheme === "none" &&
    provider.egress.authorities.length === 0 &&
    provider.egress.pathPrefixes.length === 0 &&
    provider.operations.length === 1 &&
    provider.operations[0] === "wallet.configure" &&
    fields?.length;
  const runtime =
    provider.category === "cua_runtime" &&
    provider.authKind === "configuration" &&
    provider.operations.length === 1 &&
    ["sandbox.execute", "browser.cdp"].includes(provider.operations[0]);
  if ((!wallet && !runtime) || !fields) return null;
  const names = fields.map((field) => field.name);
  if (
    names.some((name) => !name.trim()) ||
    new Set(names).size !== names.length
  )
    return null;
  return {
    provider,
    classification: {
      publicParameters: fields
        .filter((field) => !field.secret)
        .map((field) => field.name),
      privateCredentials: fields
        .filter((field) => field.secret)
        .map((field) => field.name),
    },
  };
}
