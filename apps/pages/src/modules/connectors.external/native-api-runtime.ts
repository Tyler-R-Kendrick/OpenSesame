/** Provider API-key calls and cleanup use the activation's captured transport. */
import {
  configureNativeApiConnector,
  invokeNativeApiConnector,
  nativeApiCleanup,
  testNativeApiCredential,
  verifyNativeApiConnector,
} from "@opensesame/app-core/lib/native-api-connectors.js";
import { invokeNativeApiResource } from "@opensesame/app-core/lib/native-api-resources.js";
import { compiledApiKeyRoute } from "@opensesame/app-core/lib/native-connector-availability.js";
import {
  type NativeConnectorDriver,
  type NativeDriverInput,
  registerNativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  configureNativeGithubPersonal,
  invokeNativeGithubPersonal,
  nativeGithubPersonalCleanup,
  verifyNativeGithubPersonal,
} from "@opensesame/app-core/lib/native-github-personal.js";
import { nativeKeyDriverFor } from "@opensesame/app-core/lib/native-key-drivers.js";
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
import { LeaseAbortedError, anySignal } from "../signals.js";
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
  // Linear keeps its own specialized page; the compiled contract decides the rest.
  return id !== "linear" && compiledApiKeyRoute(id);
}
function apiCleanup(
  transport: NativeProviderTransport,
): NativeConnectorDriver["cleanup"] {
  const instanceAdapters = {
    vault: nativeLocalInstanceCleanup("vault", transport),
    openbao: nativeLocalInstanceCleanup("openbao", transport),
  };
  const adapter = (id: string) => {
    if (id === "github") return nativeGithubPersonalCleanup;
    if (id === "s3") return nativeS3Cleanup;
    const keyed = nativeKeyDriverFor(id);
    if (keyed) return keyed.cleanup;
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
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  if (input.providerId === "s3") return configureNativeS3(input, transport);
  const keyed = nativeKeyDriverFor(input.providerId);
  if (keyed) return keyed.configure(input, transport);
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
function testApi(input: NativeDriverInput, transport: NativeProviderTransport) {
  transport.assertCurrent();
  if (
    input.providerId === "s3" ||
    input.providerId === "github" ||
    nativeKeyDriverFor(input.providerId)
  )
    throw new Error("This provider verifies only when it is saved");
  if (instance(input.providerId))
    throw new Error("This provider verifies only when it is saved");
  return testNativeApiCredential(input, transport);
}
async function invokeApi(
  id: string,
  operation: string,
  input: Record<string, string>,
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  const provider = providerOf(id);
  const resource = invokeNativeApiResource(
    provider,
    id,
    operation,
    input,
    transport,
  );
  if (resource) return resource;
  if (provider === "s3") return invokeNativeS3(id, operation, input, transport);
  const keyed = nativeKeyDriverFor(provider);
  if (keyed) return keyed.invoke(id, operation, input, transport);
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
  transport: NativeProviderTransport,
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
/** One caller adds cancellation to the same original route; no request recaptures. */
function ownedApiTransport(
  original: NativeProviderTransport,
  caller: AbortSignal,
  assertCaller?: () => void,
): NativeProviderTransport {
  assertCaller?.();
  caller.throwIfAborted();
  const signals = [caller];
  if (original.signal) signals.push(original.signal);
  const signal = anySignal(signals);
  const assertCurrent = () => {
    try {
      assertCaller?.();
      original.assertCurrent();
      signal.throwIfAborted();
      assertCaller?.();
    } catch {
      throw new LeaseAbortedError("This provider operation ended.");
    }
  };
  const transport = { ...original, signal, assertCurrent };
  assertCurrent();
  return transport;
}
async function runOwnedApi<Result>(
  capture: () => NativeProviderTransport,
  caller: AbortSignal,
  call: (transport: NativeProviderTransport) => Promise<Result>,
) {
  caller.throwIfAborted();
  const transport = ownedApiTransport(capture(), caller);
  try {
    const result = await call(transport);
    transport.assertCurrent();
    return result;
  } catch (error) {
    transport.assertCurrent();
    throw error;
  }
}
export function bindNativeApiRuntime(activation: Activation): void {
  const authority = captureNativeProviderAuthority();
  const cleanupRoutes = new Map<string, NativeProviderTransport>();
  activation.onDispose(() => cleanupRoutes.clear());
  const cleanupTransport = (id: string, fingerprint: string) => {
    authority.assertCurrent();
    const key = JSON.stringify([id, fingerprint]);
    const transport = cleanupRoutes.get(key) ?? authority.capture();
    transport.assertCurrent();
    cleanupRoutes.set(key, transport);
    return transport;
  };
  activation.onDispose(
    registerNativeConnectorDriver("api-key", {
      supports: supportedApiProvider,
      configure: async (input) => {
        const { owner, ...draft } = input;
        const caller = owner?.signal;
        const assertCaller = owner?.assertCurrent;
        const checkCaller = () => {
          if (owner?.signal !== caller || owner?.assertCurrent !== assertCaller)
            throw new LeaseAbortedError();
          assertCaller?.call(owner);
        };
        checkCaller();
        caller?.throwIfAborted();
        const original = authority.capture();
        const configure = async (transport: NativeProviderTransport) => {
          const configured = await configureApi(draft, transport);
          // The provider proof and publisher guard own the pre-commit checks.
          // Its own row notification can retire the old form after publication.
          authority.assertCurrent();
          const key = JSON.stringify([
            configured.connectionId,
            configured.fingerprint,
          ]);
          if (!cleanupRoutes.has(key)) cleanupRoutes.set(key, original);
          return configured;
        };
        return configure(
          caller ? ownedApiTransport(original, caller, checkCaller) : original,
        );
      },
      test: async (input) => testApi(input, authority.capture()),
      verify: async (id) => {
        const transport = authority.capture();
        const provider = providerOf(id);
        if (provider === "s3") return verifyNativeS3(id, transport);
        const keyed = nativeKeyDriverFor(provider);
        if (keyed) return keyed.verify(id, transport);
        if (provider === "github")
          return verifyNativeGithubPersonal(id, transport);
        return instance(provider)
          ? verifyNativeLocalInstance(id, transport)
          : verifyNativeApiConnector(id, transport);
      },
      invoke: async (id, operation, input, signal) =>
        signal === undefined
          ? invokeApi(id, operation, input, authority.capture())
          : runOwnedApi(authority.capture, signal, (transport) =>
              invokeApi(id, operation, input, transport),
            ),
      cleanup: {
        classification: (configuration) =>
          apiCleanup(authority.capture()).classification(configuration),
        credentialSlots: (configuration, grant) => {
          const slots = apiCleanup(authority.capture()).credentialSlots;
          return slots && "call" in slots
            ? slots(configuration, grant)
            : (slots ?? []);
        },
        cleanup: (obligation, context) =>
          apiCleanup(
            cleanupTransport(
              context.connectionId,
              context.configuration.fingerprint,
            ),
          ).cleanup(obligation, context),
      },
    }),
  );
}
