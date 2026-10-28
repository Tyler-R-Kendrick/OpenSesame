/**
 * The routes a provider's compiled contract admits, read without any runtime
 * state. A connector card and its page decide availability from these, never
 * from whether a runtime driver has finished activating (ADR 0147): the card
 * the person sees is drawn the moment its section mounts, and the contract —
 * not the driver's registration order — says what this device can configure.
 */
import { connectPlan } from "./connect-plan.js";
import { nativeKeyDriverFor } from "./native-key-drivers.js";

/** Providers whose api-key or OIDC flow ships compiled into this bundle. */
const COMPILED_INSTANCE_ROUTES = new Set(["github", "s3", "vault", "openbao"]);

function hasCompiledApiKeyPreset(providerId: string): boolean {
  const plan = connectPlan(providerId);
  return (
    !!plan &&
    !plan.refused &&
    plan.methods.some(
      (method) =>
        method.kind === "api-key" &&
        !!method.preset &&
        ((!!method.preset.auth && !!method.preset.verify) ||
          method.preset.credentialVariants.some(
            (variant) => !!variant.auth && !!variant.verify,
          )),
    )
  );
}

/** The api-key route a browser can configure from the compiled contract alone. */
export function compiledApiKeyRoute(providerId: string): boolean {
  return (
    COMPILED_INSTANCE_ROUTES.has(providerId) ||
    nativeKeyDriverFor(providerId) !== null ||
    hasCompiledApiKeyPreset(providerId)
  );
}

/** The self-hosted instance sign-in route (Vault, OpenBao). */
export function compiledOidcRoute(providerId: string): boolean {
  return providerId === "vault" || providerId === "openbao";
}
