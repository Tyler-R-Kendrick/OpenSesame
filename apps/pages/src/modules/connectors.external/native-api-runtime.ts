/** Provider API-key calls and cleanup use the activation's captured transport. */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import {
  configureNativeApiConnector,
  invokeNativeApiConnector,
  nativeApiCleanup,
  verifyNativeApiConnector,
} from "@opensesame/app-core/lib/native-api-connectors.js";
import {
  type NativeConnectorDriver,
  type NativeDriverInput,
  registerNativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  configureNativeLocalInstance,
  nativeLocalInstanceCleanup,
  readNativeLocalInstance,
  verifyNativeLocalInstance,
} from "@opensesame/app-core/lib/native-local-instance.js";
import type { Activation } from "../activation.js";

function instance(providerId: string): providerId is "vault" | "openbao" {
  return providerId === "vault" || providerId === "openbao";
}
function providerOf(id: string): string {
  const view = readNativeConnector(id);
  if (!view) throw new Error("Saved provider connection not found");
  return view.providerId;
}
function validateInstanceInput(input: NativeDriverInput): void {
  if (
    input.method !== "api-key" ||
    Object.keys(input.requestedScopes).length ||
    Object.keys(input.targetIds).length
  )
    throw new Error(
      "This provider instance does not accept selected scopes or targets",
    );
  if (
    Object.keys(input.parameters).some(
      (key) => !["endpoint", "namespace"].includes(key),
    ) ||
    Object.keys(input.credentials).some((key) => key !== "api_key")
  )
    throw new Error(
      "This provider instance received an unsupported configuration field",
    );
}
export function bindNativeApiRuntime(activation: Activation): void {
  const transport = nativeProviderTransport();
  const instanceAdapters = {
    vault: nativeLocalInstanceCleanup("vault", transport),
    openbao: nativeLocalInstanceCleanup("openbao", transport),
  };
  const cleanup: NativeConnectorDriver["cleanup"] = {
    credentialSlots: (configuration, grant) => {
      transport.assertCurrent();
      if (instance(configuration.providerId)) return ["api_key"];
      const slots = nativeApiCleanup.credentialSlots ?? [];
      return "call" in slots ? slots(configuration, grant) : slots;
    },
    classification: (configuration) => {
      transport.assertCurrent();
      return instance(configuration.providerId)
        ? instanceAdapters[configuration.providerId].classification(
            configuration,
          )
        : nativeApiCleanup.classification(configuration);
    },
    cleanup: (obligation, context) => {
      transport.assertCurrent();
      return instance(obligation.providerId)
        ? instanceAdapters[obligation.providerId].cleanup(obligation, context)
        : nativeApiCleanup.cleanup(obligation, context);
    },
  };
  activation.onDispose(
    registerNativeConnectorDriver("api-key", {
      supports: (id) => {
        if (instance(id)) return true;
        const plan = connectPlan(id);
        return (
          id !== "linear" &&
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
      },
      configure: (input) => {
        transport.assertCurrent();
        if (!instance(input.providerId))
          return configureNativeApiConnector(input, transport);
        validateInstanceInput(input);
        return configureNativeLocalInstance(
          {
            providerId: input.providerId,
            connectionId: input.connectionId,
            revision: input.revision,
            displayName: input.displayName,
            icon: input.icon ?? "",
            endpoint: input.parameters.endpoint ?? "",
            namespace: input.parameters.namespace ?? "",
            apiKey: input.credentials.api_key ?? "",
          },
          transport,
        );
      },
      verify: (id) => {
        transport.assertCurrent();
        return instance(providerOf(id))
          ? verifyNativeLocalInstance(id, transport)
          : verifyNativeApiConnector(id, transport);
      },
      invoke: async (id, operation, input) => {
        transport.assertCurrent();
        if (!instance(providerOf(id)))
          return invokeNativeApiConnector(id, operation, input, transport);
        if (operation !== "provider.read" || Object.keys(input).length)
          throw new Error("Select a supported provider operation");
        const facts = await readNativeLocalInstance(id, transport);
        return {
          label: "Provider token access verified",
          items: facts.policies.map((policy) => ({
            id: policy,
            label: policy,
          })),
        };
      },
      cleanup,
    }),
  );
}
