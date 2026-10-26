/** One provider contract drives its form; no Vercel credentials are collected. */
import type { BrowserUnavailableKind } from "@opensesame/app-core/lib/browser-disposition.js";
import type {
  ConnectMethod,
  ConnectPlan,
  McpInfo,
  OauthPreset,
} from "@opensesame/app-core/lib/connect-plan.js";
import type { NativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { nativeMcpMetadataUnavailableReason } from "@opensesame/app-core/lib/native-mcp-availability.js";
import { configuredNativeOAuthPreset } from "@opensesame/app-core/lib/native-oauth-resource-preset.js";
import { nativeBrowserOAuthDescriptor } from "./native-browser-oauth-descriptor.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
  NativeScopeGroup,
} from "./native-connector-ui.js";
import { configuredMcpDescriptor } from "./native-mcp-configured-descriptor.js";
import {
  type NativeOAuthResourceOptions,
  nativeOAuthResourceDescriptor,
  nativePublicApplicationDescriptor,
} from "./native-oauth-resource-descriptor.js";
import {
  providerApiKeyFields,
  providerParameterField,
} from "./native-provider-fields.js";
import { nativePolicyMethod } from "./native-provider-policy.js";

export type BrowserProviderAvailability = {
  callbackUrl: string;
  apiKey: { available: boolean; reason?: string };
  oauth: {
    available: boolean;
    registeredAvailable?: boolean;
    reason?: string;
    preset?: OauthPreset;
    profile?: NativeBrowserOAuthProfile;
    scopeGroups?: NativeScopeGroup[];
  };
  mcp: {
    available: boolean;
    reason?: string;
    inactiveReason?: string;
    actor: string;
    defaultScopes?: readonly string[];
  };
};

function scopes(preset: OauthPreset): NativeScopeGroup[] {
  return [
    {
      actor: "user",
      label: "Permissions",
      help: "Permissions requested from this provider when you authorize the connection.",
      choices: preset.scopes.map((scope) => ({
        name: scope.name,
        description: scope.description,
        default: scope.default,
      })),
    },
  ];
}

function unavailableOAuthKind(
  preset: OauthPreset | null,
  reason: string | undefined,
): BrowserUnavailableKind {
  if (reason) return "no-contract";
  return preset && preset.tokenAuth !== "none"
    ? "needs-client-secret"
    : "no-public-contract";
}

function unavailableOAuthReason(preset: OauthPreset | null): string {
  if (!preset)
    return "This provider does not publish a browser OAuth application contract. Use another supported connection method.";
  return preset.tokenAuth === "none"
    ? "This provider's public OAuth application route is not supported here. Use its supported MCP authorization route when available."
    : "This provider requires a confidential OAuth client. Its token exchange cannot run in a browser without exposing a client secret.";
}

function oauthDescriptor(
  method: Extract<ConnectMethod, { kind: "oauth" }>,
  availability: BrowserProviderAvailability["oauth"],
  callbackUrl: string,
): NativeMethodDescriptor {
  const preset = availability.preset ?? method.preset;
  return {
    id: "oauth",
    authorizeFirst: true,
    preferredRank: 50,
    label: "Bring Your Own OAuth App",
    available: availability.available && preset !== null,
    unavailableReason: availability.reason ?? unavailableOAuthReason(preset),
    unavailableKind: unavailableOAuthKind(preset, availability.reason),
    instructions:
      "Register a public browser application with this provider. Use the callback shown below and authorize only the permissions you need.",
    fields: preset
      ? [
          {
            id: "client_id",
            label: "Public OAuth client ID",
            kind: "text",
            secret: false,
            required: true,
          },
          {
            id: "redirect_uri",
            label: "OAuth callback URL",
            kind: "url",
            secret: false,
            required: false,
            defaultValue: callbackUrl,
            readOnly: true,
            displayOnly: true,
          },
          ...preset.templateParams.map(providerParameterField),
        ]
      : [],
    scopeGroups: availability.scopeGroups ?? (preset ? scopes(preset) : []),
    links: preset?.consoleUrl
      ? [{ label: "Register an application", url: preset.consoleUrl }]
      : [],
  };
}

function apiDescriptor(
  plan: ConnectPlan,
  method: Extract<ConnectMethod, { kind: "api-key" }>,
  availability: BrowserProviderAvailability["apiKey"],
): NativeMethodDescriptor {
  const preset = method.preset;
  const available =
    availability.available &&
    !!preset &&
    ((!!preset.auth && !!preset.verify) ||
      preset.credentialVariants.some(
        (variant) => !!variant.auth && !!variant.verify,
      ));
  return {
    id: "api-key",
    label: "API Key",
    preferredRank: 30,
    available,
    unavailableReason:
      availability.reason ??
      "This provider does not publish a browser-verifiable API-key route in the connector contract.",
    unavailableKind: availability.reason ? "no-contract" : "no-key-check",
    instructions:
      preset?.instructions ??
      "Use a provider-supported browser authentication method when available.",
    fields: preset ? providerApiKeyFields(plan.name, preset) : [],
    scopeGroups: [],
    links: preset?.keyUrl
      ? [{ label: `Create ${plan.name} credentials`, url: preset.keyUrl }]
      : [],
  };
}

function mcpUnavailableAdvice(
  providerId: string,
  metadata: McpInfo,
  availability: BrowserProviderAvailability["mcp"],
): Pick<NativeMethodDescriptor, "unavailableReason" | "unavailableKind"> {
  const reason =
    availability.reason ??
    nativeMcpMetadataUnavailableReason(providerId, metadata) ??
    undefined;
  if (!availability.available && reason === undefined)
    return {
      unavailableKind: "runtime-inactive",
      unavailableReason:
        availability.inactiveReason ??
        "Enable External connectors in Settings › Features to activate this connection on this device.",
    };
  return {
    unavailableKind: "no-public-contract",
    unavailableReason:
      reason ??
      "The provider has not advertised a public browser authorization contract for its MCP server.",
  };
}

function mcpDescriptor(
  providerId: string,
  method: Extract<ConnectMethod, { kind: "mcp" }>,
  availability: BrowserProviderAvailability["mcp"],
): NativeMethodDescriptor {
  const metadata = method.mcp.status === "ok" ? method.mcp : null;
  const defaults = availability.defaultScopes ?? metadata?.defaultScopes;
  const descriptor: NativeMethodDescriptor = {
    id: "mcp",
    authorizeFirst: true,
    preferredRank:
      metadata?.status === "ok" && metadata.registration !== "manual" ? 10 : 40,
    label:
      metadata && metadata.registration !== "manual" ? "Managed MCP" : "MCP",
    available: availability.available,
    ...mcpUnavailableAdvice(providerId, method.mcp, availability),
    instructions:
      "Connect to this provider's published MCP server. OpenSesame verifies its advertised tools before reporting a connection.",
    fields:
      metadata?.registration === "manual"
        ? [
            {
              id: "client_id",
              label: "Public MCP client ID",
              kind: "text",
              secret: false,
              required: true,
            },
          ]
        : [],
    scopeGroups: metadata
      ? [
          {
            actor: availability.actor,
            label: "MCP permissions",
            choices: metadata.scopes.map((scope) => ({
              name: scope,
              description:
                "Permission advertised by the provider's MCP authorization server.",
              default: defaults?.includes(scope) ?? false,
            })),
          },
        ]
      : [],
  };
  return metadata?.configurable === false
    ? descriptor
    : configuredMcpDescriptor(providerId, method.mcp, descriptor);
}

function publicOAuthDescriptor(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
  method: Extract<ConnectMethod, { kind: "oauth" }>,
): NativeMethodDescriptor {
  const configured = configuredNativeOAuthPreset(plan);
  const preset =
    availability.oauth.preset ?? method.preset ?? configured?.preset;
  const profile = availability.oauth.profile;
  const options: NativeOAuthResourceOptions = configured ?? {};
  if (availability.oauth.available && profile) {
    const publicMethod = {
      ...nativeBrowserOAuthDescriptor(plan, profile, availability.callbackUrl),
      preferredRank: 20,
    };
    return preset
      ? nativePublicApplicationDescriptor(
          preset,
          availability.callbackUrl,
          true,
          publicMethod,
          profile,
          {
            ...options,
            resourceParameter:
              profile.mode === "google-token" ? "omit" : undefined,
          },
        )
      : publicMethod;
  }
  if (
    profile?.mode === "google-token" &&
    preset &&
    availability.oauth.registeredAvailable
  )
    return {
      ...nativeOAuthResourceDescriptor(preset, availability.callbackUrl, true, {
        resourceParameter: "omit",
      }),
      preferredRank: 35,
    };
  if (profile && !preset)
    return oauthDescriptor(
      method,
      availability.oauth,
      availability.callbackUrl,
    );
  if (profile && preset) {
    // A public profile is not an alternative to a confidential OAuth app.
    // Keep the token-auth selector and its client-secret field so a user can
    // register their own application even when the public popup is refused.
    return nativePublicApplicationDescriptor(
      preset,
      availability.callbackUrl,
      availability.oauth.available ||
        availability.oauth.registeredAvailable === true,
      nativeBrowserOAuthDescriptor(plan, profile, availability.callbackUrl),
      profile,
    );
  }
  if (preset)
    return {
      ...nativeOAuthResourceDescriptor(
        preset,
        availability.callbackUrl,
        availability.oauth.available,
      ),
      preferredRank: 35,
    };
  return oauthDescriptor(method, availability.oauth, availability.callbackUrl);
}

function additionalOAuthMethod(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
): NativeMethodDescriptor | null {
  if (availability.oauth.available && availability.oauth.profile)
    return publicOAuthDescriptor(plan, availability, {
      kind: "oauth",
      preset: availability.oauth.preset ?? null,
    });
  const configured = configuredNativeOAuthPreset(plan);
  if (configured)
    return {
      ...nativeOAuthResourceDescriptor(
        configured.preset,
        availability.callbackUrl,
        availability.oauth.registeredAvailable ?? availability.oauth.available,
        configured,
      ),
      preferredRank: 35,
    };
  if (
    (availability.oauth.available || availability.oauth.registeredAvailable) &&
    (availability.oauth.profile || availability.oauth.preset)
  )
    return publicOAuthDescriptor(plan, availability, {
      kind: "oauth",
      preset: availability.oauth.preset ?? null,
    });
  return null;
}

function providerMethods(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
  savedMethod?: NativeMethodDescriptor["id"],
): NativeMethodDescriptor[] {
  const methods: NativeMethodDescriptor[] = [];
  for (const method of plan.methods) {
    if (method.kind === "api-key")
      methods.push(apiDescriptor(plan, method, availability.apiKey));
    if (method.kind === "oauth")
      methods.push(publicOAuthDescriptor(plan, availability, method));
    if (method.kind === "mcp")
      methods.push(mcpDescriptor(plan.id, method, availability.mcp));
  }
  if (!methods.some((method) => method.id === "oauth")) {
    const additional = additionalOAuthMethod(plan, availability);
    if (additional) methods.unshift(additional);
  }
  return plan.primaryMethod
    ? methods.filter(
        (method) => method.id === (savedMethod ?? plan.primaryMethod),
      )
    : methods;
}

export function nativeProviderDescriptor(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
  savedMethod?: NativeMethodDescriptor["id"],
): NativeConnectorDescriptor {
  const methods = providerMethods(plan, availability, savedMethod).map(
    (method) => nativePolicyMethod(plan.id, method),
  );
  if (methods.length === 0)
    methods.push({
      id: "oauth",
      label: "Provider authorization",
      available: false,
      unavailableKind: "no-public-contract",
      unavailableReason: `${plan.name} publishes a hosted managed connection but no public browser authentication contract. This self-hosted app cannot provision the provider's hosted application.`,
      fields: [],
      scopeGroups: [],
    });
  return {
    providerId: plan.id,
    name: plan.name,
    docsUrl: plan.docsUrl,
    disconnectExplanation:
      availability.oauth.profile?.revoke === "settings"
        ? "Disconnect forgets the local authorization. Revoke the application or key in your provider's authorization settings to end its provider access."
        : "Disconnect removes this device's connection. API keys are forgotten locally; revoke a shared key at the provider if you also want to end its other uses.",
    methods: plan.refused
      ? methods.map((method) => ({
          ...method,
          available: false,
          unavailableKind: "policy" as const,
          unavailableReason:
            "This payment connection is unavailable under the product's connection policy.",
        }))
      : methods,
    actions: [],
  };
}
