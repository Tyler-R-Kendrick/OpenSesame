/** Public browser authorization forms describe the provider's actual consent model. */
import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type { NativeBrowserOAuthProfile } from "@opensesame/app-core/lib/native-browser-oauth-profile.js";
import type {
  NativeField,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

function fields(
  profile: NativeBrowserOAuthProfile,
  callbackUrl: string,
): NativeField[] {
  if (profile.mode === "openrouter-key") return [];
  const result: NativeField[] = [
    {
      id: "client_id",
      label: `${profile.name} public client ID`,
      kind: "text",
      secret: false,
      required: true,
      readOnly: profile.mode === "cimd",
      defaultValue:
        profile.mode === "cimd"
          ? new URL("native-client.json", callbackUrl).href
          : undefined,
    },
  ];
  result.push({
    id: profile.mode === "google-token" ? "javascript_origin" : "redirect_uri",
    label:
      profile.mode === "google-token"
        ? "Authorized JavaScript origin"
        : "OAuth callback URL",
    kind: "url",
    secret: false,
    required: false,
    readOnly: true,
    displayOnly: true,
    defaultValue:
      profile.mode === "google-token"
        ? new URL(callbackUrl).origin
        : callbackUrl,
  });
  for (const parameter of profile.publicParameters) {
    if (parameter === "tenant")
      result.push({
        id: parameter,
        label: "Microsoft tenant ID",
        kind: "text",
        secret: false,
        required: false,
        defaultValue: "common",
        help: "Use a directory UUID, common, organizations, or consumers. Register this callback as a Single-page application redirect.",
      });
    if (parameter === "instance_url")
      result.push({
        id: parameter,
        label: "GitLab instance",
        kind: "url",
        secret: false,
        required: false,
        readOnly: true,
        defaultValue: "https://gitlab.com",
        help: "This public browser profile is verified for GitLab.com. Disable the Confidential setting when registering your application.",
      });
  }
  return result;
}

export function nativeBrowserOAuthDescriptor(
  plan: ConnectPlan,
  profile: NativeBrowserOAuthProfile,
  callbackUrl: string,
): NativeMethodDescriptor {
  const compiled = plan.methods.find((method) => method.kind === "oauth");
  const choices =
    compiled?.kind === "oauth" ? (compiled.preset?.scopes ?? []) : [];
  const permissions = new Map(choices.map((choice) => [choice.name, choice]));
  for (const name of profile.requiredScopes)
    permissions.set(name, {
      name,
      description:
        "Required to verify the provider account for this connection.",
      default: true,
    });
  return {
    id: "oauth",
    label:
      profile.mode === "cimd"
        ? "Managed OAuth"
        : profile.mode === "openrouter-key"
          ? "Authorize with OpenRouter"
          : "Bring Your Own OAuth App",
    available: true,
    instructions:
      profile.mode === "cimd"
        ? "This self-hosted application publishes its public OAuth client metadata at the HTTPS address below. The provider verifies that document before your consent; no confidential credential is used."
        : profile.mode === "openrouter-key"
          ? "Authorize with OpenRouter to create a key for this connection. Review its provider settings before granting access."
          : profile.mode === "google-token"
            ? "Register a Google web client for the JavaScript origin below. Google opens a consent popup and issues a short-lived access token; renew it with another consent action."
            : "Register a public browser application. Copy the callback below and select the permissions you need. No client secret is used.",
    fields: fields(profile, callbackUrl),
    scopeGroups: permissions.size
      ? [
          {
            actor: "user",
            label: "User permissions",
            help: "The account-verification permissions must remain selected to connect. Other permissions are optional.",
            choices: [...permissions.values()],
            requiredScopes: profile.requiredScopes,
          },
        ]
      : [],
    links: [
      {
        label: `${profile.name} browser authorization guide`,
        url: profile.docsUrl,
      },
    ],
  };
}
