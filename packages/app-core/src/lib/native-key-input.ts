/** The form a key-driven provider's connection accepts, and nothing else (ADR 0198). */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";

/** Refuse a form that asks for a scope, a target or a field the provider's form does not offer. */
export function assertOnlyFields(
  input: NativeApiConfigureInput,
  parameters: readonly string[],
  credentials: readonly string[],
  message: string,
): void {
  const stray =
    Object.keys(input.requestedScopes ?? {}).length > 0 ||
    Object.keys(input.targetIds ?? {}).length > 0 ||
    Object.keys(input.parameters).some((key) => !parameters.includes(key)) ||
    Object.keys(input.credentials).some((key) => !credentials.includes(key));
  if (stray) throw new Error(message);
}
