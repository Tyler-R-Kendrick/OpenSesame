import { nativeApiTarget } from "./native-api-target.js";
/** Provider-created API keys are forgotten locally; the browser does not revoke them. */
import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";

export const nativeApiCleanup: NativeProviderCleanup = {
  classification: (configuration) => {
    if (configuration.method !== "api-key")
      throw new Error("API-key cleanup belongs to an API-key connection");
    return nativeApiTarget(configuration.providerId, configuration.parameters)
      .classification;
  },
  cleanup: async (obligation, context) => {
    if (
      context.configuration.method !== "api-key" ||
      obligation.providerId !== context.configuration.providerId ||
      obligation.fingerprint !== context.configuration.fingerprint ||
      obligation.kind !== "revoke" ||
      !obligation.grant ||
      obligation.grant.kind !== "api-key" ||
      obligation.grant.providerId !== obligation.providerId ||
      obligation.grant.actor !== obligation.actor ||
      obligation.grant.fingerprint !== obligation.fingerprint ||
      obligation.grant.targetId !== obligation.targetId
    )
      throw new Error(
        "This API-key connection has an unsupported provider cleanup obligation",
      );
    return "local-credential-forgotten";
  },
};
