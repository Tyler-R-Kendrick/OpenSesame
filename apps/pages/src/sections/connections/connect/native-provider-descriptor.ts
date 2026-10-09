/** One provider contract drives its form; no Vercel credentials are collected. */
import type {
  ConnectMethod,
  ConnectPlan,
  OauthPreset,
} from "@opensesame/app-core/lib/connect-plan.js";
import type { NativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { nativeBrowserOAuthDescriptor } from "./native-browser-oauth-descriptor.js";
import type {
  NativeConnectorDescriptor,
  NativeMethodDescriptor,
  NativeScopeGroup,
} from "./native-connector-ui.js";
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
    reason?: string;
    preset?: OauthPreset;
    profile?: NativeBrowserOAuthProfile;
    scopeGroups?: NativeScopeGroup[];
  };
  mcp: { available: boolean; reason?: string; actor: string };
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
    label: "Bring Your Own OAuth App",
    available: availability.available && preset !== null,
    unavailableReason: availability.reason ?? unavailableOAuthReason(preset),
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
    available,
    unavailableReason:
      availability.reason ??
      "This provider does not publish a browser-verifiable API-key route in the connector contract.",
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

function mcpDescriptor(
  method: Extract<ConnectMethod, { kind: "mcp" }>,
  availability: BrowserProviderAvailability["mcp"],
): NativeMethodDescriptor {
  const metadata = method.mcp.status === "ok" ? method.mcp : null;
  return {
    id: "mcp",
    label:
      metadata && metadata.registration !== "manual" ? "Managed MCP" : "MCP",
    available: availability.available,
    unavailableReason:
      availability.reason ??
      "The provider has not advertised a public browser authorization contract for its MCP server.",
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
              default: false,
            })),
          },
        ]
      : [],
  };
}

function publicOAuthDescriptor(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
  method: Extract<ConnectMethod, { kind: "oauth" }>,
): NativeMethodDescriptor {
  if (availability.oauth.available && availability.oauth.profile)
    return nativeBrowserOAuthDescriptor(
      plan,
      availability.oauth.profile,
      availability.callbackUrl,
    );
  return oauthDescriptor(method, availability.oauth, availability.callbackUrl);
}

function providerMethods(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
): NativeMethodDescriptor[] {
  const methods: NativeMethodDescriptor[] = [];
  for (const method of plan.methods) {
    if (method.kind === "api-key")
      methods.push(apiDescriptor(plan, method, availability.apiKey));
    if (method.kind === "oauth")
      methods.push(publicOAuthDescriptor(plan, availability, method));
    if (method.kind === "mcp")
      methods.push(mcpDescriptor(method, availability.mcp));
  }
  const publicOAuth =
    availability.oauth.available &&
    (availability.oauth.profile || availability.oauth.preset);
  if (publicOAuth && !plan.methods.some((method) => method.kind === "oauth"))
    methods.push(
      publicOAuthDescriptor(plan, availability, {
        kind: "oauth",
        preset: availability.oauth.preset ?? null,
      }),
    );
  return methods;
}

export function nativeProviderDescriptor(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
): NativeConnectorDescriptor {
  const methods = providerMethods(plan, availability).map((method) =>
    nativePolicyMethod(plan.id, method),
  );
  if (methods.length === 0)
    methods.push({
      id: "oauth",
      label: "Provider authorization",
      available: false,
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
          unavailableReason:
            "This payment connection is unavailable under the product's connection policy.",
        }))
      : methods,
    actions: [],
  };
}
