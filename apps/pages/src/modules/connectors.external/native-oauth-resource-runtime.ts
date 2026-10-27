/** Configured applications share the public driver without changing its provider protocols. */
import { connectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { nativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import type {
  NativeConnectorDriver,
  NativeDriverInput,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeConfiguration } from "@opensesame/app-core/lib/native-connector-schema.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type {
  NativeProviderTransport,
  captureNativeProviderAuthority,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  NativeOAuthClientTarget,
  nativeOAuthClientTarget,
  normalizeNativeOAuthClientParameters,
} from "@opensesame/app-core/lib/native-oauth-client-config.js";
import { NativeOAuthError } from "@opensesame/app-core/lib/native-oauth-errors.js";
import { createNativeOAuthResourceDriver } from "@opensesame/app-core/lib/native-oauth-resource-driver.js";
import { configuredNativeOAuthPreset } from "@opensesame/app-core/lib/native-oauth-resource-preset.js";
import { createNativeOriginDriver } from "@opensesame/app-core/lib/native-origin-driver.js";
import { captureSecretBackendVault } from "@opensesame/app-core/lib/secret-backends/runtime-owners.js";

type Authority = ReturnType<typeof captureNativeProviderAuthority>;
export function supportsNativeOAuthResource(id: string): boolean {
  const plan = connectPlan(id);
  return !!plan && !plan.refused && configuredNativeOAuthPreset(plan) !== null;
}
/** A partial registered target is invalid, never permission to adopt a public profile. */
export function nativeOAuthClientConfigured(
  configuration: NativeConfiguration,
): boolean {
  if (configuration.providerId === "origin") return false;
  if (configuration.method !== "oauth") return false;
  if (
    ![...NativeOAuthClientTarget.keyof().options, "redirect_uri"].some(
      (key) => key in configuration.parameters,
    )
  )
    return false;
  const target = nativeOAuthClientTarget(configuration);
  if (!target.resource) throw new NativeOAuthError("callback");
  return true;
}
function registeredInput(input: NativeDriverInput): boolean {
  const { client_id, redirect_uri, ...supplied } = input.parameters;
  const target = normalizeNativeOAuthClientParameters(supplied);
  if (!NativeOAuthClientTarget.keyof().options.some((key) => key in target))
    return false;
  const parsed = NativeOAuthClientTarget.parse(target);
  if (!client_id || !parsed.resource) throw new NativeOAuthError("callback");
  return true;
}
function captureOwner(
  authority: Authority,
  redirectUri: string,
  caller?: AbortSignal,
  captured?: NativeProviderTransport,
) {
  caller?.throwIfAborted();
  authority.assertCurrent();
  const original = captured ?? authority.capture();
  const signal = AbortSignal.any([
    ...(original.signal ? [original.signal] : []),
    ...(caller ? [caller] : []),
  ]);
  original.assertCurrent();
  return captureSecretBackendVault(signal).then((guard) => {
    try {
      const combined = AbortSignal.any([signal, guard.signal]);
      const assertCurrent = () => {
        combined.throwIfAborted();
        original.assertCurrent();
        if (guard.guest || !guard.current())
          throw new NativeOAuthError("expired");
      };
      assertCurrent();
      return {
        tomb: guard.tomb,
        redirectUri,
        transport: { ...original, signal: combined, assertCurrent },
        close: guard.close,
      };
    } catch (error) {
      guard.close();
      throw error;
    }
  });
}
export function composeNativeOAuthResourceDriver(
  publicDriver: NativeConnectorDriver,
  authority: Authority,
  redirectUri: string,
): NativeConnectorDriver {
  const capture = (signal?: AbortSignal, original?: NativeProviderTransport) =>
    captureOwner(authority, redirectUri, signal, original);
  const configured = createNativeOAuthResourceDriver({
    supports: supportsNativeOAuthResource,
    capture,
  });
  const origin = createNativeOriginDriver({ capture });
  const forConfiguration = (configuration: NativeConfiguration) => {
    if (configuration.providerId === "origin") return origin;
    if (nativeOAuthClientConfigured(configuration)) {
      if (!configured.supports(configuration.providerId))
        throw new NativeOAuthError("callback");
      return configured;
    }
    if (!publicDriver.supports(configuration.providerId))
      throw new NativeOAuthError("callback");
    return publicDriver;
  };
  const forConnection = (id: string) => {
    const view = readNativeConnector(id);
    if (!view) throw new NativeOAuthError("callback");
    return forConfiguration(view.configuration);
  };
  const configure = (input: NativeDriverInput) => {
    if (input.providerId === "origin") return origin.configure(input);
    if (
      ["cimd", "provider"].includes(input.parameters.token_auth_method ?? "")
    ) {
      const profile = nativeBrowserOAuthProfile(input.providerId);
      if (
        !profile ||
        (profile.mode === "cimd") !==
          (input.parameters.token_auth_method === "cimd")
      )
        throw new NativeOAuthError("callback");
      const { token_auth_method, ...parameters } = input.parameters;
      return publicDriver.configure({ ...input, parameters });
    }
    if (registeredInput(input)) {
      if (!configured.supports(input.providerId))
        throw new NativeOAuthError("callback");
      return configured.configure(input);
    }
    if (!publicDriver.supports(input.providerId))
      throw new NativeOAuthError("callback");
    return publicDriver.configure(input);
  };
  return {
    supports: (id) => publicDriver.supports(id) || configured.supports(id),
    configure,
    authorize: (id, actor) => {
      const driver = forConnection(id);
      if (!driver.authorize) throw new NativeOAuthError("callback");
      return driver.authorize(id, actor);
    },
    verify: (id) => forConnection(id).verify(id),
    invoke: (id, operation, input, signal) =>
      forConnection(id).invoke(id, operation, input, signal),
    cleanup: {
      capture: (id) =>
        forConnection(id).cleanup.capture?.(id) ?? authority.capture(),
      classification: (configuration) =>
        forConfiguration(configuration).cleanup.classification(configuration),
      credentialSlots: (configuration, grant) => {
        const slots =
          forConfiguration(configuration).cleanup.credentialSlots ?? [];
        return "call" in slots ? slots(configuration, grant) : slots;
      },
      prepare: (id, original) => {
        const prepare = forConnection(id).cleanup.prepare;
        return (
          (original === undefined ? prepare?.(id) : prepare?.(id, original)) ??
          Promise.resolve()
        );
      },
      finalize: (id, original) => {
        const finalize = forConnection(id).cleanup.finalize;
        return (
          (original === undefined
            ? finalize?.(id)
            : finalize?.(id, original)) ?? Promise.resolve()
        );
      },
      cleanup: (obligation, context) =>
        forConfiguration(context.configuration).cleanup.cleanup(
          obligation,
          context,
        ),
    },
  };
}
