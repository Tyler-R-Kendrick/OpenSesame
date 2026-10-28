import type { ConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import type { NativeMethodDescriptor } from "./native-connector-ui.js";
import type { BrowserProviderAvailability } from "./native-provider-descriptor.js";

export function nativeOriginMethodDescriptor(
  plan: ConnectPlan,
  availability: BrowserProviderAvailability,
): NativeMethodDescriptor {
  const method = plan.methods.find((entry) => entry.kind === "oauth");
  const preset = method?.kind === "oauth" ? method.preset : null;
  return {
    id: "oauth",
    label: "Cursor Origin app",
    authorizeFirst: true,
    preferredRank: 20,
    available: availability.oauth.available && preset !== null,
    unavailableReason:
      availability.oauth.reason ??
      "Enable External connectors to configure this Origin app on this device.",
    unavailableKind: "no-public-contract",
    instructions:
      "Register an Origin app, add its Ed25519 public signing key, and register the callback shown below. The private PKCS#8 key stays sealed in your open vault. Installation returns a short-lived receipt; OpenSesame verifies it with Origin's signing keys, mints an installation token, and checks the rate-limit resource before connecting.",
    fields: [
      {
        id: "client_id",
        label: "Origin app ID",
        kind: "text",
        secret: false,
        required: true,
        placeholder: "app_01…",
      },
      {
        id: "redirect_uri",
        label: "Origin callback URL",
        kind: "url",
        secret: false,
        required: false,
        defaultValue: availability.callbackUrl,
        readOnly: true,
        displayOnly: true,
      },
      {
        id: "private_key",
        label: "Origin Ed25519 PKCS#8 private key",
        kind: "text",
        secret: true,
        required: true,
        placeholder: "-----BEGIN PRIVATE KEY-----",
        help: "Stored as a sealed Token item in your open vault. Cursor holds only the matching public key. Leave blank only when retaining the same saved configuration.",
      },
    ],
    scopeGroups: preset
      ? [
          {
            actor: "user",
            label: "Installation permissions",
            choices: preset.scopes,
          },
        ]
      : [],
    links: preset?.consoleUrl
      ? [{ label: "Register an Origin app", url: preset.consoleUrl }]
      : [],
  };
}
