/** What the Tailscale connection form draws (ADR 0218). */
import type { NativeKeyField, NativeKeyUi } from "./native-key-types.js";

export const API_TOKEN = "api_token";
export const CLIENT_ID = "client_id";
export const CLIENT_SECRET = "client_secret";

const YES_NO = [
  { id: "no", label: "No" },
  { id: "yes", label: "Yes" },
] as const;

const DEVICE_FIELD: NativeKeyField = {
  id: "device",
  label: "Device ID",
  kind: "text",
  secret: false,
  required: true,
  placeholder: "from the device list",
};

const TAILSCALE_UI: NativeKeyUi = {
  name: "Tailscale",
  methodLabel: "API access token or OAuth client",
  instructions:
    "In the Tailscale admin console open Settings → Keys, and either generate an API access token, or create an OAuth client with the scopes you need and paste its ID and secret. Tailscale's cloud API answers no web page, so the call is carried by the OpenSesame connector bridge; the credential is proved by reading your tailnet's devices, an OAuth token is used once and not kept, and nothing Tailscale says back in an error is repeated.",
  fields: [
    {
      id: "tailnet",
      label: "Tailnet",
      kind: "text",
      secret: false,
      required: false,
      placeholder: "-",
      help: "Leave as - for the credential's own tailnet.",
    },
    {
      id: API_TOKEN,
      label: "API access token",
      kind: "text",
      secret: true,
      required: false,
      placeholder: "tskey-api-…",
      help: "Use this, or the OAuth client below.",
    },
    {
      id: CLIENT_ID,
      label: "OAuth client ID",
      kind: "text",
      secret: true,
      required: false,
    },
    {
      id: CLIENT_SECRET,
      label: "OAuth client secret",
      kind: "text",
      secret: true,
      required: false,
      placeholder: "tskey-client-…",
    },
  ],
  links: [
    {
      label: "Tailscale API",
      url: "https://tailscale.com/api",
    },
    {
      label: "OAuth clients",
      url: "https://tailscale.com/kb/1215/oauth-clients",
    },
  ],
  disconnectExplanation:
    "Disconnect forgets this device's token or client secret. It revokes nothing at Tailscale: revoke the key or client in the admin console to end its other uses.",
  actions: [
    { id: "provider.devices.read", label: "List devices", fields: [] },
    {
      id: "provider.device.authorize",
      label: "Approve a device",
      fields: [DEVICE_FIELD],
    },
    {
      id: "provider.device.rename",
      label: "Rename a device",
      fields: [
        DEVICE_FIELD,
        {
          id: "name",
          label: "New name",
          kind: "text",
          secret: false,
          required: true,
          placeholder: "laptop",
        },
      ],
    },
    { id: "provider.keys.read", label: "List auth keys", fields: [] },
    {
      id: "provider.key.create",
      label: "Create an auth key",
      fields: [
        {
          id: "tags",
          label: "Tags",
          kind: "text",
          secret: false,
          required: false,
          placeholder: "tag:server",
        },
        {
          id: "reusable",
          label: "Reusable",
          kind: "choice",
          secret: false,
          required: false,
          defaultValue: "no",
          choices: YES_NO,
        },
        {
          id: "ephemeral",
          label: "Ephemeral",
          kind: "choice",
          secret: false,
          required: false,
          defaultValue: "no",
          choices: YES_NO,
        },
        {
          id: "expiry_days",
          label: "Expires in (days)",
          kind: "text",
          secret: false,
          required: false,
          placeholder: "1",
        },
      ],
    },
  ],
};

export function nativeTailscaleUi(): NativeKeyUi {
  return TAILSCALE_UI;
}
