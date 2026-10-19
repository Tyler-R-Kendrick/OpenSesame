// Generated from spec/connectors/secret-backend-presets.json; do not edit.
import type { SecretBackendPreset } from "./presets.js";
export const SECRET_BACKEND_PRESETS: readonly SecretBackendPreset[] = [
  {
    "providerId": "byo-secret-backend",
    "label": "BYO Secret Backend",
    "modes": [
      "local",
      "file-import",
      "credential-management",
      "onepassword-sdk",
      "onepassword-connect",
      "bitwarden-api",
      "bitwarden-secrets",
      "infisical",
      "passwordstate",
      "proton-pass"
    ],
    "defaultMode": "local",
    "docsUrl": "https://developer.mozilla.org/en-US/docs/Web/API/File_API",
    "setup": "Choose a local vault, an export file, browser credentials, a native SDK, or a documented HTTP protocol. Use a 1Password service account token for native SDK access. HTTP connections use your supplied endpoint and credential; allow this browser origin through CORS. No local process is started.",
    "fileFormats": [
      {
        "id": "bitwarden-json",
        "label": "Bitwarden JSON"
      },
      {
        "id": "bitwarden-csv",
        "label": "Bitwarden CSV"
      },
      {
        "id": "1password-1pux",
        "label": "1Password 1PUX"
      },
      {
        "id": "1password-csv",
        "label": "1Password CSV"
      },
      {
        "id": "protonpass-json",
        "label": "Proton Pass JSON or ZIP"
      },
      {
        "id": "keepass-kdbx",
        "label": "KeePass KDBX"
      },
      {
        "id": "keepassxc-csv",
        "label": "KeePassXC CSV"
      },
      {
        "id": "env-file",
        "label": "Environment file"
      },
      {
        "id": "generic-csv",
        "label": "CSV"
      }
    ]
  },
  {
    "providerId": "local-vault",
    "label": "Local vault",
    "modes": [
      "local"
    ],
    "defaultMode": "local",
    "docsUrl": "https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system",
    "setup": "Use the open vault on this device. Items stay in its encrypted storage and follow its existing lock and backup rules.",
    "fileFormats": []
  },
  {
    "providerId": "browser-credentials",
    "label": "Browser credentials",
    "modes": [
      "credential-management"
    ],
    "defaultMode": "credential-management",
    "docsUrl": "https://developer.mozilla.org/en-US/docs/Web/API/Credential_Management_API",
    "setup": "Request an origin-scoped password through your browser. The browser chooses the credential; this method cannot enumerate or delete password-manager vaults.",
    "fileFormats": []
  },
  {
    "providerId": "1password",
    "label": "1Password",
    "modes": [
      "onepassword-sdk",
      "onepassword-connect",
      "file-import"
    ],
    "defaultMode": "onepassword-sdk",
    "docsUrl": "https://www.1password.dev/sdks",
    "setup": "Use the native browser SDK with your 1Password account URL, vault ID and a service account token scoped to that vault. The selected vault must allow item reads; writes require the corresponding permissions. The SDK authenticates directly with your account and decrypts items on this device. You can also choose a configured Connect server, import 1PUX/CSV, or explicitly save an item through the official Save in 1Password button.",
    "fileFormats": [
      {
        "id": "1password-1pux",
        "label": "1Password 1PUX"
      },
      {
        "id": "1password-csv",
        "label": "1Password CSV"
      }
    ]
  },
  {
    "providerId": "bitwarden",
    "label": "Bitwarden",
    "modes": [
      "bitwarden-api",
      "bitwarden-secrets",
      "file-import"
    ],
    "defaultMode": "bitwarden-api",
    "docsUrl": "https://bitwarden.com/help/bitwarden-apis/",
    "setup": "Use a configured Vault Management API endpoint, Secrets Manager machine account, or export file. Vault Management is an existing bw serve service (or a protected same-origin endpoint); the PWA calls HTTP and starts no process. The organization Public API does not expose vault items.",
    "fileFormats": [
      {
        "id": "bitwarden-json",
        "label": "Bitwarden JSON"
      },
      {
        "id": "bitwarden-csv",
        "label": "Bitwarden CSV"
      }
    ]
  },
  {
    "providerId": "vaultwarden",
    "label": "Vaultwarden",
    "modes": [
      "bitwarden-api",
      "file-import"
    ],
    "defaultMode": "bitwarden-api",
    "docsUrl": "https://github.com/dani-garcia/vaultwarden/wiki",
    "setup": "Use a Vault Management API service signed into your Vaultwarden server, or import a Bitwarden-compatible export. The Vaultwarden server URL itself is not the decrypted Vault Management API.",
    "fileFormats": [
      {
        "id": "bitwarden-json",
        "label": "Bitwarden JSON"
      },
      {
        "id": "bitwarden-csv",
        "label": "Bitwarden CSV"
      }
    ]
  },
  {
    "providerId": "bitwarden-sm",
    "label": "Bitwarden Secrets Manager",
    "modes": [
      "bitwarden-secrets"
    ],
    "defaultMode": "bitwarden-secrets",
    "docsUrl": "https://bitwarden.com/help/secrets-manager-sdk/",
    "setup": "Use a scoped machine account access token. The official browser WebAssembly SDK decrypts secrets locally. Configure your regional or self-hosted API and identity URLs with CORS for this browser.",
    "fileFormats": []
  },
  {
    "providerId": "infisical",
    "label": "Infisical",
    "modes": [
      "infisical"
    ],
    "defaultMode": "infisical",
    "docsUrl": "https://infisical.com/docs/api-reference/overview/introduction",
    "setup": "Use your Infisical API endpoint, project, environment and folder. Authenticate with a machine identity through Universal Auth, or a scoped access token. Permit this browser origin through CORS.",
    "fileFormats": []
  },
  {
    "providerId": "passwordstate",
    "label": "Passwordstate",
    "modes": [
      "passwordstate"
    ],
    "defaultMode": "passwordstate",
    "docsUrl": "https://www.clickstudios.com.au/passwordstate/application-programming-interface",
    "setup": "Use your Passwordstate site URL, password list ID and scoped API key. Permit this browser origin through CORS and give the key only the item permissions you need.",
    "fileFormats": []
  },
  {
    "providerId": "proton-pass",
    "label": "Proton Pass",
    "modes": [
      "proton-pass",
      "file-import"
    ],
    "defaultMode": "proton-pass",
    "docsUrl": "https://github.com/protonpass/pass-cli",
    "setup": "Use a scoped whole-vault personal access token and its PAT share ID. Paste the complete token including the local key after ::. The public protocol client/version defaults to cli-pass@2.4.2, matching the official CLI; change it if your API deployment requires another supported version. This header is not a credential. Editor access enables writes; items decrypt on this device. Exports remain an optional import method.",
    "fileFormats": [
      {
        "id": "protonpass-json",
        "label": "Proton Pass JSON or ZIP"
      }
    ]
  }
];
