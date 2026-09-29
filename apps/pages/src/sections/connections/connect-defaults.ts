import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { configurationDefaults } from "@opensesame/app-core/lib/connector-guidance.js";

/** The fields a provider fills itself, before the person types anything. */
export function defaultsFor(provider: Provider): Record<string, string> {
  const defaults = new Map<string, string>();
  for (const [key, value] of Object.entries(configurationDefaults(provider))) {
    if (value !== undefined) defaults.set(key, value);
  }
  return Object.fromEntries(defaults);
}
