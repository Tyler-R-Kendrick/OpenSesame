import type { OauthPreset } from "@opensesame/app-core/lib/connect-plan.js";
/** Standard configurable OAuth fields are rendered by the existing common connection form. */
import type { NativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
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
export function nativeOAuthResourceDescriptor(
  preset: OauthPreset,
  callbackUrl: string,
  available: boolean,
  resourceParameter?: "send" | "omit",
): NativeMethodDescriptor {
  const secret = (
    method: "client_secret_basic" | "client_secret_post",
  ): NativeField => ({
    id: "client_secret",
    label: "OAuth client secret",
    kind: "text",
    secret: true,
    required: true,
    when: { fieldId: "token_auth_method", value: method },
    help: "Stored as a sealed Token item in your open vault. This operator credential is not a public application secret. Leave blank only when retaining the same saved configuration.",
  });
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
    fields: [
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
      publicEndpoint("token_endpoint", "Token endpoint", preset.tokenEndpoint),
      publicEndpoint(
        "resource",
        "API resource URL",
        preset.verify?.method === "GET"
          ? preset.verify.url
          : preset.userinfoEndpoint,
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
          { id: "client_secret_post", label: "Client secret in request body" },
        ],
      },
      ...resourceParameterFields(resourceParameter),
      secret("client_secret_basic"),
      secret("client_secret_post"),
    ],
    scopeGroups: [
      { actor: "user", label: "Permissions", choices: preset.scopes },
    ],
    links: preset.consoleUrl
      ? [{ label: "Register an application", url: preset.consoleUrl }]
      : [],
  };
}

/** Reuse common conditional fields; only one variant of each field ID is visible. */
export function nativeCimdApplicationDescriptor(
  preset: OauthPreset,
  callbackUrl: string,
  available: boolean,
  publicMethod: NativeMethodDescriptor,
  profile: NativeBrowserOAuthProfile,
): NativeMethodDescriptor {
  const registered = nativeOAuthResourceDescriptor(
    preset,
    callbackUrl,
    available,
  );
  const selector = registered.fields.find(
    (field) => field.id === "token_auth_method",
  );
  if (!selector || profile.mode !== "cimd")
    throw new Error("Expected a CIMD application contract");
  const methods = ["none", "client_secret_basic", "client_secret_post"];
  return {
    ...registered,
    label: "OAuth application",
    fields: [
      {
        ...selector,
        label: "OAuth application",
        defaultValue: "cimd",
        choices: [
          { id: "cimd", label: "Provider-managed metadata (CIMD)" },
          ...(selector.choices ?? []),
        ],
      },
      ...publicMethod.fields.map((field) => ({
        ...field,
        when: { fieldId: "token_auth_method", value: "cimd" },
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
    instructions: `${publicMethod.instructions}\n${registered.instructions}`,
    links: [...(publicMethod.links ?? []), ...(registered.links ?? [])],
  };
}
