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
  configureNativeGithubPersonal,
  invokeNativeGithubPersonal,
  nativeGithubPersonalCleanup,
  verifyNativeGithubPersonal,
} from "@opensesame/app-core/lib/native-github-personal.js";
import {
  configureNativeLocalInstance,
  nativeLocalInstanceCleanup,
  readNativeLocalInstance,
  verifyNativeLocalInstance,
} from "@opensesame/app-core/lib/native-local-instance.js";
import {
  configureNativeS3,
  invokeNativeS3,
  nativeS3Cleanup,
  verifyNativeS3,
} from "@opensesame/app-core/lib/native-s3.js";
import { readNativeVaultToken } from "@opensesame/app-core/lib/native-vault-token-read.js";
import type { Activation } from "../activation.js";
import { nativeVaultSecretItems } from "./native-vault-kv-output.js";

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
function supportedApiProvider(id: string): boolean {
  if (instance(id) || id === "github" || id === "s3") return true;
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
}
function apiCleanup(
  transport: ReturnType<typeof nativeProviderTransport>,
): NativeConnectorDriver["cleanup"] {
  const instanceAdapters = {
    vault: nativeLocalInstanceCleanup("vault", transport),
    openbao: nativeLocalInstanceCleanup("openbao", transport),
  };
  const adapter = (id: string) => {
    if (id === "github") return nativeGithubPersonalCleanup;
    if (id === "s3") return nativeS3Cleanup;
    return instance(id) ? instanceAdapters[id] : nativeApiCleanup;
  };
  return {
    credentialSlots: (configuration, grant) => {
      transport.assertCurrent();
      if (
        instance(configuration.providerId) ||
        configuration.providerId === "github"
      )
        return ["api_key"];
      const slots = adapter(configuration.providerId).credentialSlots ?? [];
      return "call" in slots ? slots(configuration, grant) : slots;
    },
    classification: (configuration) => {
      transport.assertCurrent();
      return adapter(configuration.providerId).classification(configuration);
    },
    cleanup: (obligation, context) => {
      transport.assertCurrent();
      return adapter(obligation.providerId).cleanup(obligation, context);
    },
  };
}
function configureApi(
  input: NativeDriverInput,
  transport: ReturnType<typeof nativeProviderTransport>,
) {
  transport.assertCurrent();
  if (input.providerId === "s3") return configureNativeS3(input, transport);
  if (input.providerId === "github")
    return configureNativeGithubPersonal(input, transport);
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
}
async function invokeApi(
  id: string,
  operation: string,
  input: Record<string, string>,
  transport: ReturnType<typeof nativeProviderTransport>,
) {
  transport.assertCurrent();
  const provider = providerOf(id);
  if (provider === "s3") return invokeNativeS3(id, operation, input, transport);
  if (provider === "github")
    return invokeNativeGithubPersonal(id, operation, input, transport);
  if (!instance(provider))
    return invokeNativeApiConnector(id, operation, input, transport);
  return invokeInstance(id, operation, input, transport);
}
async function invokeInstance(
  id: string,
  operation: string,
  input: Record<string, string>,
  transport: ReturnType<typeof nativeProviderTransport>,
) {
  if (
    operation === "provider.secret.read" &&
    !Object.keys(input).some((key) => !["mount", "path"].includes(key))
  ) {
    const secret = await readNativeVaultToken(
      id,
      { mount: input.mount ?? "secret", path: input.path ?? "" },
      transport,
    );
    return {
      label: `Secret version ${secret.metadata.version}`,
      items: nativeVaultSecretItems(secret.data),
    };
  }
  if (operation !== "provider.read" || Object.keys(input).length)
    throw new Error("Select a supported provider operation");
  const facts = await readNativeLocalInstance(id, transport);
  return {
    label: "Provider token access verified",
    items: facts.policies.map((policy) => ({ id: policy, label: policy })),
  };
}
export function bindNativeApiRuntime(activation: Activation): void {
  const transport = nativeProviderTransport();
  activation.onDispose(
    registerNativeConnectorDriver("api-key", {
      supports: supportedApiProvider,
      configure: (input) => configureApi(input, transport),
      verify: (id) => {
        transport.assertCurrent();
        const provider = providerOf(id);
        if (provider === "s3") return verifyNativeS3(id, transport);
        if (provider === "github")
          return verifyNativeGithubPersonal(id, transport);
        return instance(provider)
          ? verifyNativeLocalInstance(id, transport)
          : verifyNativeApiConnector(id, transport);
      },
      invoke: (id, operation, input) =>
        invokeApi(id, operation, input, transport),
      cleanup: apiCleanup(transport),
    }),
  );
}
