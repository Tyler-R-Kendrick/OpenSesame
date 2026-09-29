import { isString } from "@opensesame/os-domain";
import type { Provider } from "./connections.js";

export { fieldGuidance } from "./field-guidance.js";

export function configurationDefaults(provider: Pick<Provider, "id">) {
  if (provider.id === "keychain") return { service: "opensesame" };
  if (provider.id === "plain") return { namespace: "opensesame" };
  if (provider.id === "better-auth") {
    return { api_key_header: "x-api-key", config_id: "default" };
  }
  return {};
}

export function canConfigureAutomatically(
  provider: Pick<Provider, "autoConfigurable">,
): boolean {
  return provider.autoConfigurable;
}

export { isConnectionCatalogProvider } from "./catalog-provider.js";

export function configurationPayload(
  provider: Pick<Provider, "id">,
  values: Record<string, string>,
) {
  const payload = Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value !== ""),
  );
  if (provider.id !== "auth0" || !isString(payload.domain)) {
    return payload;
  }
  const domain = payload.domain
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  payload.domain = domain;
  payload.audience ||= `https://${domain}/api/v2/`;
  return payload;
}

export function needsScopeSelection(
  provider: Pick<Provider, "scopes">,
  selected: string[],
): boolean {
  return provider.scopes.length > 0 && selected.length === 0;
}
