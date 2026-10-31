/** What the Bitwarden and Vaultwarden connection form draws (ADR 0218). */
import { canonicalProviderId } from "./connector-catalog.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  EMAIL,
  PASSWORD,
} from "./native-bitwarden-vault-api.js";
import type { NativeKeyUi } from "./native-key-types.js";

export const isSelfHosted = (providerId: string) =>
  canonicalProviderId(providerId) === "vaultwarden";

export function nativeBitwardenVaultUi(providerId: string): NativeKeyUi {
  const hosted = isSelfHosted(providerId);
  const name = hosted ? "Vaultwarden" : "Bitwarden";
  return {
    name,
    methodLabel: "Personal API key and master password",
    instructions: `In ${name} open Account settings → Security → Keys and view your API key. Paste its client ID and client secret, with your account email and master password. The master password never leaves this device: it derives the key that opens your vault here, with Web Crypto. ${hosted ? "A self-hosted server is reached directly, so it must answer this site." : "Bitwarden's servers answer no web page, so the calls are carried by the OpenSesame connector bridge."} Only personal items are read, and the vault's encrypted data must fit in 1 MiB. A password or note is shown once and never kept.`,
    fields: [
      hosted
        ? {
            id: "server",
            label: "Server address",
            kind: "url",
            secret: false,
            required: true,
            placeholder: "https://vault.example.com",
          }
        : {
            id: "site",
            label: "Region",
            kind: "choice",
            secret: false,
            required: true,
            defaultValue: "us",
            choices: [
              { id: "us", label: "US (bitwarden.com)" },
              { id: "eu", label: "EU (bitwarden.eu)" },
            ],
          },
      {
        id: EMAIL,
        label: "Account email",
        kind: "text",
        secret: true,
        required: true,
      },
      {
        id: PASSWORD,
        label: "Master password",
        kind: "text",
        secret: true,
        required: true,
      },
      {
        id: CLIENT_ID,
        label: "API key client ID",
        kind: "text",
        secret: true,
        required: true,
        placeholder: "user.…",
      },
      {
        id: CLIENT_SECRET,
        label: "API key client secret",
        kind: "text",
        secret: true,
        required: true,
      },
    ],
    links: [
      {
        label: hosted ? "Vaultwarden" : "Bitwarden public API",
        url: hosted
          ? "https://github.com/dani-garcia/vaultwarden/wiki"
          : "https://bitwarden.com/help/personal-api-key/",
      },
    ],
    disconnectExplanation: `Disconnect forgets this device's API key, email and master password. It revokes nothing at ${name}: rotate the API key in your account to end its other uses.`,
    actions: [
      { id: "provider.names.read", label: "List item names", fields: [] },
      {
        id: "provider.item.read",
        label: "Read a password or note",
        fields: [
          {
            id: "item",
            label: "Item ID",
            kind: "text",
            secret: false,
            required: true,
            placeholder: "from the list",
          },
        ],
      },
    ],
  };
}
