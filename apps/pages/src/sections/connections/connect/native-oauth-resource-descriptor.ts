import type { OauthPreset } from "@opensesame/app-core/lib/connect-plan.js";
/** Standard configurable OAuth fields are rendered by the existing common connection form. */
import type { NativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import { GOOGLE_ACCOUNT_POLICY } from "@opensesame/app-core/lib/native-google-account-policy.generated.js";
import type {
  NativeField,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";
function publicEndpoint(
  id: string,
  label: string,
  value: string | null,
): NativeField {
  return {
    id,
    label,
    kind: "url",
    secret: false,
    required: true,
    defaultValue: value && !/[{}]/.test(value) ? value : undefined,
  };
}
function resourceParameterFields(value?: "send" | "omit"): NativeField[] {
  return value
    ? [
        {
          id: "resource_parameter",
          label: "Authorization resource parameter",
          kind: "choice",
          secret: false,
          required: true,
          defaultValue: value,
          choices: [
            { id: "send", label: "Send the configured API resource" },
            { id: "omit", label: "Use scopes without a resource parameter" },
          ],
          help: "Select the authorization-server contract. The configured API resource is always checked before this connection is verified.",
        },
      ]
    : [];
}
export type NativeOAuthResourceOptions = {
  resourceParameter?: "send" | "omit";
  protocol?: "mcp";
  endpoint?: string;
  transport?: "streamable-http" | "sse";
  postEndpoint?: string;
  accountOnly?: boolean;
};
const googleAccountForbiddenFields = new Set(
  GOOGLE_ACCOUNT_POLICY.forbiddenParameters,
);
function mcpFields(options: NativeOAuthResourceOptions): NativeField[] {
  const when = { fieldId: "resource_protocol", value: "mcp" };
  return [
    {
      id: "resource_protocol",
      label: "Resource API protocol",
      kind: "choice",
      secret: false,
      required: false,
      defaultValue: options.protocol,
      choices: [
        { id: "json", label: "JSON HTTP API" },
        { id: "mcp", label: "MCP" },
      ],
      help: "MCP verifies initialization and advertised tools before connecting. JSON verifies an actual resource read.",
    },
    {
      id: "mcp_endpoint",
      label: "MCP server endpoint",
      kind: "url",
      secret: false,
      required: true,
      defaultValue: options.endpoint,
      when,
      help: "The exact MCP request URL; the API resource above remains its OAuth audience. Never put credentials in a URL.",
    },
    {
      id: "mcp_transport",
      label: "MCP transport",
      kind: "choice",
      secret: false,
      required: true,
      defaultValue: options.transport ?? "streamable-http",
      when,
      choices: [
        { id: "streamable-http", label: "Streamable HTTP" },
        { id: "sse", label: "Legacy SSE" },
      ],
    },
    {
      id: "mcp_post_endpoint",
      label: "MCP messages endpoint",
      kind: "url",
      secret: false,
      required: false,
      defaultValue: options.postEndpoint,
      when,
      help: "Required for Legacy SSE. Pin the provider's exact same-origin messages path; a server announcement cannot expand this destination.",
    },
  ];
}
function oauthClientSecretField(
  method: "client_secret_basic" | "client_secret_post",
): NativeField {
  return {
    id: "client_secret",
    label: "OAuth client secret",
    kind: "text",
    secret: true,
    required: true,
    when: { fieldId: "token_auth_method", value: method },
    help: "Stored as a sealed Token item in your open vault. This operator credential is not a public application secret. Leave blank only when retaining the same saved configuration.",
  };
}

function permittedOAuthFields(
  fields: NativeField[],
  accountOnly = false,
): NativeField[] {
  if (!accountOnly) return fields;
  return fields.filter((field) => !googleAccountForbiddenFields.has(field.id));
}

function oauthScopeGroups(
  preset: OauthPreset,
  accountOnly = false,
): NativeMethodDescriptor["scopeGroups"] {
  return [
    {
      actor: "user",
      label: "Permissions",
      choices: preset.scopes,
      requiredScopes: accountOnly
        ? [...GOOGLE_ACCOUNT_POLICY.scopes]
        : undefined,
    },
  ];
}

export function nativeOAuthResourceDescriptor(
  preset: OauthPreset,
  callbackUrl: string,
  available: boolean,
  options: NativeOAuthResourceOptions = {},
): NativeMethodDescriptor {
  return {
    id: "oauth",
    label: "Bring Your Own OAuth App",
    authorizeFirst: true,
    available,
    unavailableReason: available
      ? undefined
      : "Enable External connectors to configure this OAuth application on this device.",
    instructions:
      "Configure your registered OAuth application and exact API resource. Authorization uses PKCE. A connection is verified only after the configured resource returns JSON with its issued access token. Disconnect forgets local authorization; revoke provider access in your application's settings.",
    fields: permittedOAuthFields(
      [
        {
          id: "client_id",
          label: "OAuth client ID",
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
          readOnly: true,
          displayOnly: true,
          defaultValue: callbackUrl,
        },
        publicEndpoint("issuer", "OAuth issuer URL", preset.serverUrl),
        publicEndpoint(
          "authorization_endpoint",
          "Authorization endpoint",
          preset.authorizationEndpoint,
        ),
        publicEndpoint(
          "token_endpoint",
          "Token endpoint",
          preset.tokenEndpoint,
        ),
        {
          id: "token_relay_url",
          label: "Token relay URL (optional)",
          kind: "url",
          secret: false,
          required: false,
          help: "Use a relay you control to keep the client secret off this device. The relay receives the authorization-code form and performs the exchange at the token endpoint.",
        },
        publicEndpoint(
          "resource",
          "API resource URL",
          preset.verify?.url ?? preset.userinfoEndpoint,
        ),
        {
          id: "token_auth_method",
          label: "Token endpoint authentication",
          kind: "choice",
          secret: false,
          required: true,
          defaultValue: preset.tokenAuth,
          choices: [
            { id: "none", label: "Public client (PKCE)" },
            { id: "client_secret_basic", label: "Client secret in HTTP Basic" },
            {
              id: "client_secret_post",
              label: "Client secret in request body",
            },
          ],
        },
        ...resourceParameterFields(
          options.resourceParameter ?? preset.resourceParameter,
        ),
        ...mcpFields(options),
        oauthClientSecretField("client_secret_basic"),
        oauthClientSecretField("client_secret_post"),
      ],
      options.accountOnly,
    ),
    scopeGroups: oauthScopeGroups(preset, options.accountOnly),
    links: preset.consoleUrl
      ? [{ label: "Register an application", url: preset.consoleUrl }]
      : [],
  };
}

/** Reuse common conditional fields; only one variant of each field ID is visible. */
export function nativePublicApplicationDescriptor(
  preset: OauthPreset,
  callbackUrl: string,
  available: boolean,
  publicMethod: NativeMethodDescriptor,
  profile: NativeBrowserOAuthProfile,
  options: NativeOAuthResourceOptions = {},
): NativeMethodDescriptor {
  const registered = nativeOAuthResourceDescriptor(
    preset,
    callbackUrl,
    available,
    options,
  );
  const selector = registered.fields.find(
    (field) => field.id === "token_auth_method",
  );
  if (!selector) throw new Error("Expected an OAuth application contract");
  const mode = profile.mode === "cimd" ? "cimd" : "provider";
  const methods = ["none", "client_secret_basic", "client_secret_post"];
  return {
    ...registered,
    preferredRank: publicMethod.preferredRank,
    label: "OAuth application",
    fields: [
      {
        ...selector,
        label: "OAuth application",
        defaultValue: mode,
        choices: [
          {
            id: mode,
            label:
              profile.mode === "cimd"
                ? "Provider-managed metadata (CIMD)"
                : publicMethod.label,
          },
          ...(selector.choices ?? []),
        ],
      },
      ...publicMethod.fields.map((field) => ({
        ...field,
        when: { fieldId: "token_auth_method", value: mode },
      })),
      ...registered.fields
        .filter((field) => field.id !== "token_auth_method")
        .flatMap((field) =>
          field.when
            ? [field]
            : methods.map((value) => ({
                ...field,
                when: { fieldId: "token_auth_method", value },
              })),
        ),
    ],
    scopeGroups:
      profile.id === "codeberg"
        ? publicMethod.scopeGroups
        : publicMethod.scopeGroups.length
          ? publicMethod.scopeGroups.map((group) => ({
              ...group,
              choices: [
                ...new Map(
                  [
                    ...(
                      registered.scopeGroups.find(
                        (row) => row.actor === group.actor,
                      )?.choices ?? []
                    ).map((choice) => ({ ...choice, default: false })),
                    ...group.choices,
                  ].map((choice) => [choice.name, choice]),
                ).values(),
              ],
            }))
          : registered.scopeGroups,
    instructions: `${publicMethod.instructions}\n${registered.instructions}`,
    links: [...(publicMethod.links ?? []), ...(registered.links ?? [])],
  };
}
